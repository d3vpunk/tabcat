import AppKit
import Foundation
import SwiftTerm

@MainActor
final class Run: ObservableObject, Identifiable {
    enum State: Equatable {
        case running
        case finished(Int32?)

        var failed: Bool {
            if case let .finished(code) = self { return code != 0 }
            return false
        }
    }

    /// Where a run is on screen. One is in front at a time; everything else waits in
    /// the rail as a badge.
    ///
    /// A value the model hands out, not state a run carries: which one is in front is
    /// a property of the arrangement. Stored here it also published on the wrong
    /// object — the view that positions cards observes the model, so a card that
    /// changed places did not move until something unrelated happened to publish.
    enum Presentation: Equatable {
        case foreground
        case badge
    }

    let id = UUID()
    /// What actually runs — after handle expansion, not what was typed.
    let command: String
    let cwd: String
    let startedAt = Date()

    @Published private(set) var state: State = .running

    /// Where the shell stood when it exited, once it has.
    ///
    /// This is what makes `cd x && make`, `z api`, `pushd`, and any rc-defined
    /// wrapper move the prompt — none of which a scan of the line could see. The
    /// REPL solved it the same way and for the same reason (`executor.ts:137`): the
    /// child reports its own `pwd`, so nothing has to be understood in advance.
    private(set) var finalCwd: String?

    private let pwdFile = FileManager.default.temporaryDirectory
        .appendingPathComponent("tabcat-run-\(UUID().uuidString)")

    /// The terminal, owned by the run and not by a view.
    ///
    /// SwiftUI recreates its views freely; a terminal that lived in one would restart
    /// its process every time the card was re-laid-out. It is created once here and
    /// the representable only hands it out.
    let terminal = LocalProcessTerminalView(frame: .zero)

    private var delegateBox: ProcessDelegate?

    init(command: String, cwd: String) {
        self.command = command
        self.cwd = cwd
    }

    /// - Parameter onFinish: called with the exit code once the child is gone, so the
    ///   caller can report it to the daemon. `learn` belongs to whoever owns the
    ///   daemon connection, not here.
    func start(onFinish: @escaping (Int32?) -> Void) {
        terminal.nativeForegroundColor = .textColor
        // Transparent, so the card's glass shows through instead of a black slab.
        terminal.nativeBackgroundColor = .clear
        terminal.font = Typeface.measuring
        terminal.allowMouseReporting = false

        let box = ProcessDelegate { [weak self] reported in
            guard let self else { return }
            let code = reported.map(ExitStatus.normalise)
            self.finalCwd = self.readFinalCwd()
            self.state = .finished(code)
            onFinish(code)
        }
        delegateBox = box
        terminal.processDelegate = box

        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        var environment = ProcessInfo.processInfo.environment
        // Without this every run would load tabcat's own plugin from the rc file,
        // bind keys and warm a daemon.
        environment["TABCAT_PLUGIN_NO_SETUP"] = "1"
        environment["TERM"] = "xterm-256color"

        // -i so the rc file runs and aliases, functions and PATH edits exist — most
        // of what a person types is an alias.
        terminal.startProcess(
            executable: shell,
            args: ["-ic", wrapped],
            environment: environment.map { "\($0.key)=\($0.value)" },
            currentDirectory: cwd
        )
    }

    private var wrapped: String { Self.wrapped(command: command, pwdFile: pwdFile.path) }

    /// The user's line, plus the `pwd` report.
    ///
    /// `eval` around the line for the same reason the REPL uses it: the whole string
    /// is parsed in one go, and isolating the command as a single word keeps a syntax
    /// error inside it from swallowing the report that follows. The exit code is
    /// captured before `pwd` runs and handed back afterwards, so the terminal still
    /// sees what the command actually returned.
    ///
    /// A command that ends the shell itself (`exit`, `exec`) never reaches the
    /// report, and the prompt then simply stays where it was.
    ///
    /// Exposed so the diagnostic can exercise this exact string. A check that built
    /// its own copy would prove the copy.
    nonisolated static func wrapped(command: String, pwdFile: String) -> String {
        [
            "eval \(quoted(command))",
            "__tabcat_rc=$?",
            "pwd > \(quoted(pwdFile))",
            "exit $__tabcat_rc",
        ].joined(separator: "\n")
    }

    private func readFinalCwd() -> String? {
        defer { try? FileManager.default.removeItem(at: pwdFile) }
        guard let text = try? String(contentsOf: pwdFile, encoding: .utf8) else { return nil }
        let path = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Empty when the command replaced the shell (`exec`) or killed it before the
        // report — the directory simply stays where it was.
        return path.isEmpty ? nil : path
    }

    nonisolated private static func quoted(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    func terminate() {
        guard state == .running else { return }
        // SwiftTerm's `terminate()` sends SIGTERM and then cancels the dispatch source
        // that watches for the exit — and that source's handler holds the only
        // `waitpid` in the library. So nothing reaps the child afterwards and every
        // stopped run left a zombie behind for as long as the app lived — measured: a
        // SIGTERMed child that nobody waits for sits in `ps` as `Z`. Reaping it here is
        // the workaround, and it belongs here rather than in a fork of SwiftTerm.
        let pid = terminal.process?.shellPid ?? 0
        terminal.terminate()
        guard pid > 0 else { return }
        DispatchQueue.global(qos: .utility).async {
            var ignored: Int32 = 0
            // Blocking, off the main thread: SIGTERM is already sent, so this returns
            // as soon as the child is actually gone. The status is nobody's business —
            // a run is only ever terminated on its way off screen.
            waitpid(pid, &ignored, 0)
        }
    }
}

/// SwiftTerm's delegate is a class protocol, and the rest of the run is a
/// `@MainActor` observable object — a small adapter keeps the two apart.
private final class ProcessDelegate: LocalProcessTerminalViewDelegate {
    private let onExit: @MainActor (Int32?) -> Void

    init(onExit: @escaping @MainActor (Int32?) -> Void) {
        self.onExit = onExit
    }

    func processTerminated(source: TerminalView, exitCode: Int32?) {
        MainActor.assumeIsolated { onExit(exitCode) }
    }

    // The terminal resizes itself with the card; nothing here needs to react.
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
}
