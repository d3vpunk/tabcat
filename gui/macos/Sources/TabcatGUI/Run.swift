import Foundation

@MainActor
final class Run: ObservableObject, Identifiable {
    enum State: Equatable {
        case running
        case finished(Int32)

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
    @Published private(set) var output = ""
    @Published var presentation: Presentation = .foreground

    private var buffer = OutputBuffer()
    private let pty = PTYProcess()

    init(command: String, cwd: String) {
        self.command = command
        self.cwd = cwd
    }

    /// - Parameter onFinish: called with the exit code once the child is gone, so
    ///   the caller can report it to the daemon. `learn` belongs to whoever owns the
    ///   daemon connection, not here.
    func start(onFinish: @escaping (Int32) -> Void) {
        let started = pty.spawn(
            command: command,
            cwd: cwd,
            onOutput: { [weak self] chunk in
                guard let self else { return }
                self.buffer.append(chunk)
                self.output = self.buffer.text
            },
            onExit: { [weak self] code in
                guard let self else { return }
                self.buffer.finish()
                self.output = self.buffer.text
                self.state = .finished(code)
                onFinish(code)
            }
        )
        if !started {
            buffer.append("tabcat: could not open a pseudo terminal\n")
            buffer.finish()
            output = buffer.text
            state = .finished(127)
            // Deliberately NOT reported to the daemon: nothing ran, so there is
            // nothing to learn. A 127 here would teach the model that the command
            // fails, which is the opposite of true.
        }
    }

    func terminate() {
        pty.terminate()
    }
}
