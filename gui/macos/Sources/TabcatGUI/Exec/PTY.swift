import Darwin
import Foundation

/// One command in a pseudo terminal.
///
/// A PTY and not `Process` with pipes: without a terminal on the other end, git
/// drops its colours, npm drops its progress bar, and anything that asks whether
/// stdout is a tty behaves differently than it did in the shell the user is used
/// to. `Foundation.Process` cannot give a child a controlling terminal.
///
/// posix_openpt rather than openpty(3): the former is plain POSIX and reachable
/// from Swift without a bridging header.
final class PTYProcess {
    private var master: Int32 = -1
    private var pid: pid_t = -1
    private var readSource: DispatchSourceRead?
    private var exitSource: DispatchSourceProcess?

    private(set) var isRunning = false

    /// - Parameters:
    ///   - deliverOn: where the callbacks land. `.main` for the UI, but it MUST be
    ///     something the caller actually services — a command-line path without an
    ///     NSApplication or `dispatchMain()` never drains the main queue, so
    ///     callbacks scheduled there would simply never arrive.
    ///   - onOutput: raw bytes as they arrive, already decoded. Escape handling is
    ///     the buffer's job, not this one's.
    ///   - onExit: the child's exit status, or 128+signal when it was killed.
    @discardableResult
    func spawn(
        command: String,
        cwd: String,
        columns: Int = 120,
        deliverOn deliveryQueue: DispatchQueue = .main,
        onOutput: @escaping (String) -> Void,
        onExit: @escaping (Int32) -> Void
    ) -> Bool {
        let master = posix_openpt(O_RDWR | O_NOCTTY)
        guard master >= 0, grantpt(master) == 0, unlockpt(master) == 0,
              let slaveName = ptsname(master).map({ String(cString: $0) })
        else {
            if master >= 0 { close(master) }
            return false
        }
        let slave = open(slaveName, O_RDWR)
        guard slave >= 0 else {
            close(master)
            return false
        }

        // Width matters: anything that wraps or draws a progress bar asks the
        // terminal how wide it is, and a default of 80 would rewrap output the
        // card has room for.
        var size = winsize(ws_row: 40, ws_col: UInt16(columns), ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(master, TIOCSWINSZ, &size)

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_adddup2(&actions, slave, 0)
        posix_spawn_file_actions_adddup2(&actions, slave, 1)
        posix_spawn_file_actions_adddup2(&actions, slave, 2)
        posix_spawn_file_actions_addclose(&actions, master)
        posix_spawn_file_actions_addclose(&actions, slave)
        posix_spawn_file_actions_addchdir(&actions, cwd)

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        // Its own session, so the child becomes the controlling process of the pty
        // instead of inheriting ours.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))

        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        // -i so the rc file runs and aliases, functions and PATH edits exist —
        // the user types the commands they type in their shell, and half of those
        // are aliases. TABCAT_PLUGIN_NO_SETUP keeps tabcat's own plugin dormant in
        // that shell, or every single run would bind keys and warm a daemon.
        let arguments = [shell, "-ic", command]
        var environment = ProcessInfo.processInfo.environment
        environment["TABCAT_PLUGIN_NO_SETUP"] = "1"
        environment["TERM"] = environment["TERM"] ?? "xterm-256color"

        var child: pid_t = 0
        let status = withCStrings(arguments) { argv in
            withCStrings(environment.map { "\($0.key)=\($0.value)" }) { envp in
                posix_spawn(&child, shell, &actions, &attributes, argv, envp)
            }
        }
        posix_spawn_file_actions_destroy(&actions)
        posix_spawnattr_destroy(&attributes)
        close(slave)

        guard status == 0 else {
            close(master)
            return false
        }

        self.master = master
        self.pid = child
        isRunning = true

        let readSource = DispatchSource.makeReadSource(fileDescriptor: master, queue: .global(qos: .userInitiated))
        readSource.setEventHandler { [weak self] in
            guard let self else { return }
            var chunk = [UInt8](repeating: 0, count: 8192)
            let count = chunk.withUnsafeMutableBufferPointer { read(self.master, $0.baseAddress, $0.count) }
            guard count > 0 else { return }
            let text = String(decoding: chunk[0..<count], as: UTF8.self)
            deliveryQueue.async { onOutput(text) }
        }
        readSource.resume()
        self.readSource = readSource

        // A process source rather than blocking waitpid: the exit has to be noticed
        // without holding a thread for the whole run.
        //
        // `self` is captured STRONGLY here on purpose. The sources are stored on this
        // object, so a caller that only keeps the process in a local would see it
        // released, the sources cancelled, and no callback ever — a hang with no
        // error. The cycle ends when finish() clears both sources.
        let exitSource = DispatchSource.makeProcessSource(identifier: child, eventMask: .exit, queue: .global())
        exitSource.setEventHandler {
            var raw: Int32 = 0
            waitpid(child, &raw, 0)
            let code: Int32
            if raw & 0x7F == 0 {
                code = (raw >> 8) & 0xFF
            } else {
                // Killed. 128+signal is the convention every shell reports, and the
                // daemon stores exit codes, so it has to match what zsh would say.
                code = 128 + (raw & 0x7F)
            }
            deliveryQueue.async {
                self.finish()
                onExit(code)
            }
        }
        exitSource.resume()
        self.exitSource = exitSource
        return true
    }

    /// Deliberately no way to send input yet. Routing the prompt field into the pty
    /// would put a `sudo` password on screen in plain text, and a masked field needs
    /// to know when the child is asking for a secret — which cannot be detected
    /// reliably. Until that is solved properly, an interactive command hangs and is
    /// cancelled with Escape, which is at least honest.
    func terminate() {
        guard isRunning, pid > 0 else { return }
        // The whole process group: the command is a shell, and killing only the
        // shell would orphan whatever it started.
        kill(-pid, SIGTERM)
    }

    private func finish() {
        readSource?.cancel()
        readSource = nil
        exitSource?.cancel()
        exitSource = nil
        if master >= 0 { close(master) }
        master = -1
        isRunning = false
    }
}

/// Builds a NULL-terminated argv/envp for posix_spawn and keeps the buffers alive
/// for the duration of the call.
private func withCStrings<R>(_ strings: [String], _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> R) -> R {
    var pointers = strings.map { strdup($0) }
    pointers.append(nil)
    defer { for pointer in pointers { if let pointer { free(pointer) } } }
    return pointers.withUnsafeMutableBufferPointer { body($0.baseAddress!) }
}
