import Foundation

/// Where `tabcat` is, the environment it needs to run, and what it answered.
struct Tooling: Sendable {
    /// Absolute path to the executable, or the bare name when it is on PATH anyway.
    let binary: String
    /// PATH for any process that runs it. Not cosmetic: `tabcat` is a node script,
    /// so its shebang needs `node` findable too.
    let path: String
    /// The daemon socket, as `tabcat daemon path` reported it while we were checking
    /// that `tabcat` runs at all — nil when it never did.
    ///
    /// Carried rather than asked for a second time. The separate lookup that used to
    /// do this was a synchronous subprocess with no timeout, called from the main
    /// thread, in a file whose own header promises that a hung daemon can never
    /// freeze typing.
    let socketPath: String?

    var environment: [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = path
        return environment
    }

    func with(socketPath: String?) -> Tooling {
        Tooling(binary: binary, path: path, socketPath: socketPath)
    }
}

/// Finds a `tabcat` the overlay can actually run.
///
/// A bundled `.app` inherits launchd's environment, and launchd's PATH is
/// `/usr/bin:/bin:/usr/sbin:/sbin` — nothing else. Anything installed through a
/// version manager (nvm puts it under `~/.nvm/versions/node/<version>/bin`),
/// through Homebrew, or with `npm link` is invisible to it. The symptom was not an
/// error dialog: `resolveSocketPath` failed, the client stayed nil, every
/// prediction request returned before it was sent, and the ghost was permanently
/// empty — so Tab looked broken while the chip row still showed something, because
/// the git seed quietly filled it in.
///
/// `--check` never caught it, because a diagnostic is run from a terminal and a
/// terminal has the user's real PATH.
///
/// Finding the file is not enough. `tabcat` is a node script, so a resolved binary
/// on a PATH without `node` exits 127 — which is why this probes rather than
/// guesses, and why it carries a PATH around instead of just a filename.
///
/// The source of truth is the login shell, the same one `Run` executes commands
/// through: the user's environment lives in their rc file. Its answer goes to a
/// file rather than being read off stdout, because an rc file may print whatever it
/// likes — the REPL settled that question the same way in `warmShellSnapshot`.
actor ToolPath {
    static let shared = ToolPath()

    private var cached: Tooling?

    func resolve() async -> Tooling {
        if let cached { return cached }
        let inherited = Tooling(
            binary: "tabcat",
            path: ProcessInfo.processInfo.environment["PATH"] ?? "",
            socketPath: nil
        )
        // The inherited environment is right whenever the app was started from a
        // terminal, which is every development run — so try it before paying for a
        // shell startup.
        if let socket = await probe(inherited) {
            let resolved = inherited.with(socketPath: socket)
            cached = resolved
            return resolved
        }
        guard let fromShell = await askLoginShell() else {
            cached = inherited
            return inherited
        }
        let resolved = fromShell.with(socketPath: await probe(fromShell))
        cached = resolved
        return resolved
    }

    /// Asks `tabcat daemon path` and returns what it said, or nil when it could not
    /// be run at all.
    ///
    /// That op exists to be asked by front ends that cannot import the TypeScript,
    /// and it prints one line and touches nothing — which makes it both the one safe
    /// thing to probe with and the answer everything downstream needs anyway.
    private func probe(_ tooling: Tooling) async -> String? {
        guard let output = await run(
            "/usr/bin/env",
            [tooling.binary, "daemon", "path"],
            environment: tooling.environment
        ) else { return nil }
        let path = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }

    private func askLoginShell() async -> Tooling? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("tabcat-tooling-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: file) }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        // -l so a PATH exported from .zprofile counts, -i so one exported from
        // .zshrc does too. Version managers live in either, and nvm in particular is
        // usually only set up for interactive shells.
        let script = "{ command -v tabcat; printf '%s\\n' \"$PATH\"; } > \(quoted(file.path)) 2>/dev/null"
        process.arguments = ["-lic", script]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        // Same reason `Run` sets it: without it this shell loads tabcat's own
        // plugin, binds keys and warms a daemon, just to answer where a file is.
        var environment = ProcessInfo.processInfo.environment
        environment["TABCAT_PLUGIN_NO_SETUP"] = "1"
        process.environment = environment

        guard (try? process.run()) != nil else { return nil }
        // A hanging rc file must not hold the first prediction hostage.
        guard await finished(process) else {
            process.terminate()
            return nil
        }

        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        // Two lines in order, but an rc file that printed something of its own would
        // push them along — so the PATH is the last line and the binary is whatever
        // before it looks like an executable file.
        guard let path = lines.last else { return nil }
        let binary = lines.dropLast().last { FileManager.default.isExecutableFile(atPath: $0) } ?? "tabcat"
        // No socket yet — the caller probes this tooling and fills it in.
        return Tooling(binary: binary, path: path, socketPath: nil)
    }

    /// Runs something small and returns its stdout.
    ///
    /// On the same deadline as the shell probe, and for the same reason: a `tabcat`
    /// that hangs — a slow or unreachable home directory is the case this file exists
    /// for — would otherwise mean `resolve()` never returns and the client is never
    /// built, which looks exactly like the empty ghost this was written to fix.
    ///
    /// The pipe is read after the process has gone, which is safe only because the
    /// answer is one line. Anything that could fill the pipe buffer would deadlock
    /// and then hit the deadline instead.
    private func run(_ executable: String, _ arguments: [String], environment: [String: String]) async -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        guard await finished(process) else {
            process.terminate()
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    /// Waits for a process, up to a ceiling.
    ///
    /// A poll and not `terminationHandler`: the handler arrives on some other queue
    /// and would need a continuation raced against a timeout, which is more machinery
    /// than a check every 50 ms deserves for something that happens once per launch.
    private func finished(_ process: Process, within seconds: TimeInterval = 10) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        return !process.isRunning
    }

    private func quoted(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}
