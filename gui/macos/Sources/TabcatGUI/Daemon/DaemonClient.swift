import Foundation

/// One persistent unix socket, one request at a time — the same shape the zsh
/// plugin uses. Plain BSD sockets rather than NWConnection: this is a strictly
/// sequential request/response protocol on a serial queue, and a callback-driven
/// transport would only add ways for two replies to be attributed to the wrong
/// request.
///
/// All socket work happens off the main thread. A hung daemon must never freeze
/// the overlay's typing, which is exactly what a read on the main thread would do.
actor DaemonClient {
    private var fd: Int32 = -1
    private var sequence = 0
    private var buffer = Data()
    private let socketPath: String
    private let timeout: TimeInterval
    /// Where `tabcat` is and what environment it needs — a bundled app cannot
    /// assume either. See `ToolPath`.
    private let tooling: Tooling
    /// Rate limit for respawning, so a `tabcat` that cannot start does not turn
    /// every keystroke into a process launch.
    private var lastSpawn: Date?

    /// Set once the daemon reports a protocol we cannot speak. Latching is
    /// deliberate: retrying would produce the same answer every keystroke.
    private(set) var disabledReason: String?

    init(socketPath: String, timeout: TimeInterval = 0.15, tooling: Tooling) {
        self.socketPath = socketPath
        self.timeout = timeout
        self.tooling = tooling
    }

    /// The socket the CLI named, rather than a rule reimplemented here. It already
    /// lives in `paths.ts` and, mirrored, in the zsh plugin — a third copy would
    /// drift, and only on machines with a long home path or an NFS home.
    ///
    /// `ToolPath` asked while it was establishing that `tabcat` runs at all, so this
    /// is a lookup and not a process. It used to spawn one here: synchronously, with
    /// no timeout, on the main thread — which a file that opens by promising a hung
    /// daemon can never freeze typing has no business doing.
    static func resolveSocketPath(tooling: Tooling) throws -> String {
        guard let path = tooling.socketPath else {
            // 127 is the shape the underlying failure takes when `tabcat` was found
            // but `node` was not — the script's shebang, not the script.
            throw ClientError.socketPathUnavailable(
                "`\(tooling.binary) daemon path` gave no answer — is tabcat new enough, and is node on its PATH?"
            )
        }
        return path
    }

    // MARK: - Requests

    /// Returns the response rows: row 0 is the header, the rest are payload.
    func request(op: String, fields: [String] = []) async throws -> [[String]] {
        if let reason = disabledReason { throw DaemonError(code: "disabled", message: reason) }
        do {
            try connectIfNeeded()
        } catch {
            // The daemon exits after 45 minutes idle, and this front end only talks
            // on a keystroke — so coming back to a dead socket is the normal case,
            // not an edge one. Recovering by asking the user to open a terminal
            // would defeat the one situation the overlay exists for.
            //
            // Retried only here, before anything was sent. A failure mid-request
            // must NOT be retried: re-sending a `learn` would append the same
            // command to the history twice.
            guard await startDaemon() else { throw error }
            try connectIfNeeded()
        }

        sequence += 1
        let id = "g\(sequence)"
        do {
            try write(Wire.request(op: op, id: id, fields: fields))
            let rows = Wire.rows(from: try readBlock())
            guard let header = rows.first, header.count >= 2 else {
                throw ClientError.desynced
            }
            // A reply for a different id means the stream is out of step; a late
            // answer would otherwise be read as the response to the next request.
            //
            // One reply is exempt, and it is the daemon's own rule: over its connection
            // limit it answers `err - busy` and hangs up before it has read the request
            // line at all (`server.ts:120`), so there is no id yet to echo. Reported as
            // busy rather than as a desync, because the two say different things about
            // what to do next.
            let busyReply = header[0] == "err" && header[1] == "-"
            guard header[1] == id || busyReply else {
                dropConnection()
                throw ClientError.desynced
            }
            if header[0] == "err" {
                let error = DaemonError(code: header.count > 2 ? header[2] : "internal",
                                        message: header.count > 3 ? header[3] : "")
                if error.isProtocolMismatch {
                    disabledReason = "daemon speaks another protocol (\(error.message))"
                }
                // The far end already closed, and a `DaemonError` skips the cleanup in
                // the catch below because it is an answer, not a transport failure.
                if busyReply { dropConnection() }
                throw error
            }
            return rows
        } catch {
            // Any transport failure leaves the fd in an unknown state.
            if !(error is DaemonError) { dropConnection() }
            throw error
        }
    }

    // MARK: - Respawning

    /// Starts a daemon on our socket and waits for it to listen.
    ///
    /// No spawn lock on our side: the CLI already treats "someone else got there
    /// first" as success — EADDRINUSE and AlreadyRunningError both exit 0, because
    /// the desired end state holds either way. The zsh plugin races several shells
    /// into the same path on purpose.
    ///
    /// - Returns: whether a socket is reachable afterwards.
    private func startDaemon() async -> Bool {
        // A cold daemon needs ~0.3 s to listen; anything sooner than that between
        // attempts is just launching processes.
        if let lastSpawn, Date().timeIntervalSince(lastSpawn) < 5 { return false }
        lastSpawn = Date()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [tooling.binary, "daemon", "--socket", socketPath]
        process.environment = tooling.environment
        // The daemon has to outlive this app, and its output must not land in ours.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return false }

        // Poll rather than sleep once: usually ready well before the ceiling, and
        // the first keystroke after a break should not wait longer than it must.
        for _ in 0..<30 {
            try? await Task.sleep(for: .milliseconds(100))
            if (try? connectIfNeeded()) != nil { return true }
        }
        return false
    }

    // MARK: - Connection

    private func connectIfNeeded() throws {
        guard fd < 0 else { return }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8)
        // sun_path is 104 bytes on darwin; the CLI already refuses longer paths,
        // so a failure here means the two disagree.
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            throw ClientError.socketPathUnavailable("socket path too long: \(socketPath)")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
        }

        let handle = socket(AF_UNIX, SOCK_STREAM, 0)
        guard handle >= 0 else { throw ClientError.notConnected }

        var tv = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1_000_000))
        setsockopt(handle, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(handle, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(handle, $0, length) }
        }
        guard connected == 0 else {
            close(handle)
            throw ClientError.notConnected
        }
        fd = handle
        buffer = Data()
    }

    private func dropConnection() {
        if fd >= 0 { close(fd) }
        fd = -1
        buffer = Data()
    }

    private func write(_ text: String) throws {
        var remaining = Array(text.utf8)
        while !remaining.isEmpty {
            let written = remaining.withUnsafeBufferPointer { pointer in
                Darwin.write(fd, pointer.baseAddress, pointer.count)
            }
            guard written > 0 else { throw ClientError.notConnected }
            remaining.removeFirst(written)
        }
    }

    /// Reads until the blank line that terminates a block. Leftover bytes stay in
    /// `buffer`, though with one request in flight at a time there should be none.
    private func readBlock() throws -> String {
        var chunk = [UInt8](repeating: 0, count: 8192)
        while true {
            if let end = blockEnd() {
                let block = buffer.prefix(end)
                buffer.removeFirst(end + 2)
                return String(decoding: block, as: UTF8.self)
            }
            let count = chunk.withUnsafeMutableBufferPointer { pointer in
                read(fd, pointer.baseAddress, pointer.count)
            }
            if count > 0 {
                buffer.append(contentsOf: chunk[0..<count])
                continue
            }
            // 0 = the daemon hung up. -1 with EAGAIN = our receive timeout.
            throw count == 0 ? ClientError.notConnected : ClientError.timedOut
        }
    }

    /// Index of the "\n\n" that ends the block, or nil while it is incomplete.
    private func blockEnd() -> Int? {
        guard buffer.count >= 2 else { return nil }
        let bytes = [UInt8](buffer)
        for index in 0..<(bytes.count - 1) where bytes[index] == 0x0A && bytes[index + 1] == 0x0A {
            return index
        }
        return nil
    }
}
