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
    /// Newest first. One is in front, the rest wait in the rail as badges.
    @Published private(set) var runs: [Run] = []
    /// Whether the launcher (chips and prompt) is on screen. Badges stay visible
    /// either way — that is the point of sending a card away.
    @Published var launcherVisible = true
    /// The panel's current frame, so the view can convert screen positions into it.
    /// Owned here rather than passed in, because the hosting view has to see it
    /// change in the same update as the content that depends on it.
    @Published var panelFrame: CGRect = .zero
    /// How tall the launcher's glass actually is.
    ///
    /// Measured rather than assumed: the launcher sits in a fixed box, generous
    /// enough for a confirmation card, but its glass hugs its content and hangs at
    /// the box's top edge. Positioning the card below the BOX left the unused
    /// remainder as a visible gap.
    @Published var launcherHeight: CGFloat = Layout.launcherSize.height
    /// A command held back for confirmation. Waiting rather than running is the
    /// whole point, so this is a state and not a callback.
    @Published private(set) var pending: PendingRun?

    struct PendingRun {
        let command: String
        let cwd: String
        let hazards: [Hazard]
    }

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

    /// Called every time the overlay appears. After hours away the daemon has long
    /// since idled out, and the chip row would otherwise still show whatever it held
    /// before — or the seeded fallback from a failed start. The client respawns a
    /// daemon on its own, so this both heals the connection and refreshes what is on
    /// screen before the first keystroke rather than after it.
    func refresh() {
        guard let client else { return }
        Task {
            do {
                _ = try await client.request(op: "ping")
            } catch {
                status = describe(error)
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
                // A previous failure would otherwise stay on screen forever, since
                // nothing else ever clears it.
                if status != "ready" { status = "ready" }
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
        // A held-back command must not be confirmable with Enter, so Enter cannot
        // mean "start something new" while one is waiting either — that would hide
        // the question behind a fresh prompt.
        if pending != nil {
            status = "⌘Enter to run it, Escape to drop it"
            return
        }
        let line = typed
        guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        typed = ""
        ghost = ""
        handle = ""

        Task { [line] in
            // Scanned AFTER handle expansion: `@deploy` says nothing about what it
            // does, and the expansion is what actually runs.
            let command = await resolved(line)
            let cwd = self.cwd
            let hazards = HazardScan.scan(command: command, cwd: cwd)
            if hazards.isEmpty {
                start(command: command, cwd: cwd)
            } else {
                pending = PendingRun(command: command, cwd: cwd, hazards: hazards)
                status = "⌘Enter to run it, Escape to drop it"
            }
        }
    }

    /// Confirms a held-back command. Bound to ⌘Enter and not to Enter: a
    /// confirmation that the triggering key also satisfies is no confirmation at
    /// all — a habitual double-tap would sail straight through it.
    func confirmPending() {
        guard let pending else { return }
        self.pending = nil
        start(command: pending.command, cwd: pending.cwd)
    }

    func discardPending() {
        guard pending != nil else { return }
        pending = nil
        status = "dropped"
    }

    private func start(command: String, cwd: String) {
        // Whatever was in front moves to the rail rather than being replaced. The
        // previous version refused a second command outright, which for a launcher
        // built around quick one-offs meant waiting out `npm test` doing nothing.
        for existing in runs where existing.presentation == .foreground {
            existing.presentation = .badge
        }
        let run = Run(command: command, cwd: cwd)
        runs.insert(run, at: 0)
        // Oldest first out of the rail: the newest run is the one being watched.
        if runs.count > Layout.railCapacity + 1 {
            let dropped = runs.removeLast()
            dropped.terminate()
        }
        run.start { [weak self] code in
            guard let self else { return }
            if let code {
                self.report(line: command, cwd: cwd, exitCode: code)
            } else {
                // The command ran but the terminal could not tell us how it ended.
                // Reporting 0 would teach the model it succeeded, which is a guess
                // dressed as a fact — better to learn nothing.
                self.status = "exit code unknown, not learned"
            }
            self.autoDismiss(run, code: code)
        }
    }

    /// A clean run gets out of the way by itself; a failure stays, because an error
    /// nobody saw is the same as no error report at all.
    private func autoDismiss(_ run: Run, code: Int32?) {
        guard code == 0 else { return }
        Task {
            try? await Task.sleep(for: .seconds(4))
            guard runs.contains(where: { $0 === run }) else { return }
            // Still in front means it is being read; leave it alone.
            guard run.presentation == .badge else { return }
            dismiss(run)
        }
    }

    // MARK: - Foreground and rail

    var foreground: Run? { runs.first { $0.presentation == .foreground } }
    var badges: [Run] { runs.filter { $0.presentation == .badge } }

    /// Sends the run in front to the rail. This is the gesture the whole overlay was
    /// designed around: the output does not matter right now, put it away.
    func minimizeForeground() {
        guard let run = foreground else { return }
        run.presentation = .badge
    }

    /// Brings a badge back to the front, and the current front to the rail.
    func bringToFront(_ run: Run) {
        for other in runs where other !== run {
            other.presentation = .badge
        }
        run.presentation = .foreground
    }

    func dismiss(_ run: Run) {
        run.terminate()
        runs.removeAll { $0 === run }
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

    /// Escape's last resort: put the front card away, or drop it if it is finished.
    func dismissForeground() {
        guard let run = foreground else { return }
        if run.state == .running {
            // Still working: park it rather than kill it. Cancelling is what the
            // badge's own close does, deliberately, so Escape cannot destroy work by
            // being pressed one time too many.
            run.presentation = .badge
        } else {
            dismiss(run)
        }
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
