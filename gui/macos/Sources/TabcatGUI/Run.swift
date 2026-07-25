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

    /// Where this run is on screen. One run is in front at a time; everything else
    /// waits in the rail as a badge.
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
    @Published var presentation: Presentation = .foreground

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
            args: ["-ic", command],
            environment: environment.map { "\($0.key)=\($0.value)" },
            currentDirectory: cwd
        )
    }

    func terminate() {
        guard state == .running else { return }
        terminal.terminate()
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
