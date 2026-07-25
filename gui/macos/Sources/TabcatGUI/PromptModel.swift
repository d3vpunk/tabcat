import AppKit
import SwiftUI

@MainActor
final class PromptModel: ObservableObject {
    /// Five, not nine. The row shares one width: nine chips left about 25 pt per
    /// label, which truncates every one of them to three characters. Frecency
    /// ranking means the first chip is usually right anyway, so the tail cost
    /// readability for entries nobody was going to pick.
    static let directoryLimit = 5

    /// Only what the user typed. The ghost is never part of this — that is the
    /// whole reason Enter still means Enter and the caret cannot wander into a
    /// suggestion.
    @Published var typed = "" {
        didSet { if typed != oldValue { requestPrediction() } }
    }
    @Published private(set) var ghost = ""
    /// Magic-name handle the daemon offers for this line, or "".
    @Published private(set) var handle = ""
    @Published private(set) var directories: [Directory] = []
    @Published private(set) var selection = 0
    @Published private(set) var status = "connecting…"
    /// The run in the foreground, if any. One at a time for now; the badge stack
    /// that keeps several is the next step.
    @Published private(set) var run: Run?

    private var client: DaemonClient?

    /// The directory predictions are asked for. Falls back to home so a request is
    /// never sent with an empty cwd, which the daemon rejects.
    var cwd: String {
        directories.indices.contains(selection)
            ? directories[selection].path
            : FileManager.default.homeDirectoryForCurrentUser.path
    }

    // MARK: - Setup

    func connect() {
        Task {
            let path: String
            do {
                path = try DaemonClient.resolveSocketPath()
            } catch {
                status = describe(error)
                await seedDirectories(reason: "no daemon")
                return
            }
            let client = DaemonClient(socketPath: path)
            self.client = client

            // Warms the connection, so the first keystroke does not wait for it,
            // and tells us whether the daemon is there at all.
            do {
                _ = try await client.request(op: "ping")
            } catch {
                status = "no daemon at \(path) — start one with `tabcat daemon`"
                await seedDirectories(reason: "no daemon")
                return
            }
            await loadDirectories(client)
        }
    }

    private func loadDirectories(_ client: DaemonClient) async {
        do {
            let entries = try await client.cwds(limit: Self.directoryLimit)
            if entries.isEmpty {
                // Not an error: imported shell history carries no directory, so a
                // fresh install has genuinely learned none.
                await seedDirectories(reason: "nothing learned yet")
            } else {
                directories = entries.map { Directory(path: $0.path, learned: true) }
                selection = 0
                status = "ready"
            }
        } catch let error as DaemonError where error.code == "bad_op" {
            status = "daemon predates the cwds op — restart it with `tabcat daemon stop`"
            await seedDirectories(reason: "daemon too old")
        } catch {
            status = describe(error)
            await seedDirectories(reason: "cwds failed")
        }
    }

    private func seedDirectories(reason: String) async {
        let paths = await DirectorySeed.gitRepositories(limit: Self.directoryLimit)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        directories = paths.isEmpty
            ? [Directory(path: home, learned: false)]
            : paths.map { Directory(path: $0, learned: false) }
        selection = 0
        status = "\(reason) — directories guessed from git repositories on disk"
    }

    // MARK: - Directory selection

    /// The hold-⌥ cycle. Wraps, like a window switcher.
    func selectNext() {
        guard !directories.isEmpty else { return }
        select((selection + 1) % directories.count)
    }

    func selectPrevious() {
        guard !directories.isEmpty else { return }
        select((selection - 1 + directories.count) % directories.count)
    }

    /// ⌘1…⌘9. Out-of-range digits are ignored rather than clamped: jumping to a
    /// different chip than the one pressed would be worse than doing nothing.
    func select(digit: Int) -> Bool {
        let index = digit - 1
        guard directories.indices.contains(index) else { return false }
        select(index)
        return true
    }

    private func select(_ index: Int) {
        guard index != selection else { return }
        selection = index
        // The prediction was for the previous directory, so it is now wrong — the
        // cwd boost is a big part of the ranking.
        requestPrediction()
    }

    // MARK: - Prediction

    private func requestPrediction() {
        let line = typed
        // Never for an empty line, and only with a client: an empty cwd or line
        // would be rejected anyway.
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
                // user kept typing or switched directory, showing it would offer
                // text they never saw suggested for what is now on screen.
                guard line == typed, cwd == self.cwd else { return }
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
        let line = typed
        guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        // One at a time until the badge stack exists. Refusing beats silently
        // replacing a run whose output the user is still reading.
        if let run, run.state == .running {
            status = "still running — Escape cancels it"
            return
        }
        typed = ""
        ghost = ""
        handle = ""

        Task { [line] in
            let command = await resolved(line)
            let cwd = self.cwd
            let run = Run(command: command, cwd: cwd)
            self.run = run
            run.start { [weak self] code in
                self?.report(line: command, cwd: cwd, exitCode: code)
            }
        }
    }

    /// Expands a magic-name handle to the command it stands for. The daemon owns
    /// that mapping, so it is asked rather than guessed; anything else runs as typed.
    private func resolved(_ line: String) async -> String {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let client, trimmed.hasPrefix("@") || trimmed.hasPrefix("⚡") else { return line }
        let handle = String(trimmed.dropFirst())
        do {
            let rows = try await client.request(op: "names", fields: ["resolve", cwd, handle, ""])
            let expansion = rows[0].count > 2 ? rows[0][2] : ""
            return expansion.isEmpty ? line : expansion
        } catch {
            return line
        }
    }

    /// Feeds the run back into the model the zsh plugin shares. Without this the
    /// overlay would be a parallel universe: its own usage would never influence
    /// the ranking, and the chip row would never learn a directory.
    private func report(line: String, cwd: String, exitCode: Int32) {
        guard let client else { return }
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        Task {
            do {
                _ = try await client.request(op: "learn", fields: [
                    String(exitCode), String(timestamp), cwd, line,
                ])
            } catch {
                // Losing one entry is not worth interrupting the user over, but it
                // must not be silent either — the chip row depends on this.
                status = "not learned: \(describe(error))"
            }
        }
    }

    func dismissRun() {
        run?.terminate()
        run = nil
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
