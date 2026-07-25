import AppKit
import SwiftUI

@MainActor
final class PromptModel: ObservableObject {
    /// Only what the user typed. The ghost is never part of this — that is the
    /// whole reason Enter still means Enter and the caret cannot wander into a
    /// suggestion.
    @Published var typed = "" {
        didSet { if typed != oldValue { requestPrediction() } }
    }
    @Published private(set) var ghost = ""
    /// Magic-name handle the daemon offers for this line, or "".
    @Published private(set) var handle = ""
    /// The directory predictions are asked for. A chip row replaces this later;
    /// for now it is the top `cwds` entry.
    @Published private(set) var cwd: String
    @Published private(set) var status = "connecting…"
    /// Lines Enter was pressed on. Nothing is executed yet — no PTY in this build.
    @Published private(set) var wouldRun: [String] = []

    private var client: DaemonClient?

    init() {
        cwd = FileManager.default.homeDirectoryForCurrentUser.path
    }

    // MARK: - Setup

    func connect() {
        Task {
            let path: String
            do {
                path = try DaemonClient.resolveSocketPath()
            } catch {
                status = describe(error)
                return
            }
            let client = DaemonClient(socketPath: path)
            self.client = client

            // Warms the connection and tells us whether the daemon is even there
            // before the first keystroke has to wait for it.
            do {
                _ = try await client.request(op: "ping")
            } catch {
                status = "no daemon at \(path) — start one with `tabcat daemon`"
                return
            }
            await pickWorkingDirectory(client)
        }
    }

    /// The top-ranked directory, or the home directory when the daemon has none.
    /// An empty answer is the honest state of a fresh install: imported shell
    /// history carries no directory, so nothing has been learned yet.
    private func pickWorkingDirectory(_ client: DaemonClient) async {
        do {
            let entries = try await client.cwds(limit: 1)
            if let top = entries.first {
                cwd = top.path
                status = "ready"
            } else {
                status = "ready — no learned directories yet, using ~"
            }
        } catch {
            status = "ready — \(describe(error))"
        }
    }

    // MARK: - Prediction

    private func requestPrediction() {
        let line = typed
        // Only at the end of the line, and never for an empty one: a ghost behind
        // a mid-line caret is noise. The skeleton has no mid-line caret yet, but
        // the rule belongs with the request, not with the view.
        guard !line.isEmpty, let client else {
            ghost = ""
            handle = ""
            return
        }
        let cursor = line.unicodeScalars.count
        let cwd = cwd

        Task {
            do {
                let prediction = try await client.predict(line: line, cursorCodePoints: cursor, cwd: cwd, limit: 1)
                // The answer describes the line as it was when we asked. If the
                // user kept typing, showing it would offer text they never saw
                // suggested for what is now on screen.
                guard line == typed else { return }
                handle = prediction.handleHint
                ghost = prediction.candidates.first.map {
                    ghostText(for: $0, line: line, cursorCodePoints: cursor)
                } ?? ""
            } catch let error as DaemonError where error.isWarming {
                // Normal right after a cold start; the next keystroke tries again.
                guard line == typed else { return }
                ghost = ""
            } catch {
                guard line == typed else { return }
                ghost = ""
                status = describe(error)
            }
        }
    }

    // MARK: - Actions

    /// Tab and Right-Arrow: the ghost becomes real text.
    func acceptGhost() -> Bool {
        guard !ghost.isEmpty else { return false }
        typed += ghost
        return true
    }

    func submit() {
        guard !typed.isEmpty else { return }
        // No PTY in this build, so this is where execution WILL go. Showing the
        // line rather than pretending it ran keeps the gap visible.
        wouldRun.append(typed)
        typed = ""
    }

    func clear() {
        typed = ""
    }

    private func describe(_ error: Error) -> String {
        switch error {
        case let error as DaemonError: return "daemon: \(error.code) \(error.message)"
        case ClientError.timedOut: return "daemon did not answer in time"
        case ClientError.notConnected: return "daemon connection lost"
        case ClientError.desynced: return "daemon stream out of step"
        case let ClientError.socketPathUnavailable(reason): return reason
        default: return error.localizedDescription
        }
    }
}
