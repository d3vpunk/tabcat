import AppKit
import SwiftUI

@MainActor
final class PromptModel: ObservableObject {
    /// Five, not nine. The row shares one width: nine chips left about 25 pt per
    /// label, which truncates every one of them to three characters. Frecency
    /// ranking means the first chip is usually right anyway, so the tail cost
    /// readability for entries nobody was going to pick.
    ///
    /// A display cap and no longer a fetch cap. The list filters everything the daemon
    /// ranked, so the sixth directory is reachable by typing two letters of its name —
    /// it just does not get a chip.
    static let chipLimit = 5

    /// How many directories to hold for the list. Fifty rather than everything because
    /// the op takes a limit and `0` means ten to the daemon, not all of them.
    static let cwdLimit = 50

    /// Ten history hits, the number the REPL's own ^R shows.
    ///
    /// Explicit, and not `0` the way `predict` is asked. There the limit would have been
    /// an invisible cap on a ranking that is exhaustive by nature. Here it is the other
    /// way round: `search` scores a substring above a subsequence, and the subsequence
    /// tail runs to however much history there is — `tst` matches almost every line ever
    /// typed. The ranking is the filter, and ten is where it is still one.
    static let historyLimit = 10

    /// Only what the user typed. The ghost is never part of this — that is the
    /// whole reason Enter still means Enter and the caret cannot wander into a
    /// suggestion.
    @Published var typed = "" {
        didSet {
            guard typed != oldValue else { return }
            // Typing straight after an accept anchors the accepted line as its own
            // undo level. Without it ⇧Tab would silently swallow the characters typed
            // since, which is the REPL's rule and its reason (`prompt-state.ts:300`).
            if !applyingAccept, lastChangeWasAccept {
                undoStack.append(oldValue)
                lastChangeWasAccept = false
            }
            // Every edit puts the selection back on the top row. Same rule as the
            // REPL's `withLine`, and it is what makes Enter on a navigated row safe:
            // a row can only be selected deliberately, never left over from before.
            selected = 0
            requestSuggestions()
        }
    }
    /// Caret position in code points. Real, not assumed to be the end of the line:
    /// predictions are asked for this position, and editing in the middle of a line
    /// used to be answered as if the caret were at its end.
    @Published private(set) var caret = 0
    /// Ranked candidates for the current line. Empty is a real answer.
    @Published private(set) var candidates: [Candidate] = []
    /// Fuzzy history hits for the current line, from `search`. The section that makes
    /// ^R unnecessary: these match anywhere in the line, where a candidate matches a
    /// prefix.
    ///
    /// Held until the next answer arrives rather than cleared when the line changes,
    /// which means that for the moment between the two round trips this section still
    /// answers the previous keystroke. Deliberate: emptying it would make the list
    /// shrink and grow again on every character, and the run card is positioned under
    /// the launcher's measured glass — the card would twitch along with it. Safe
    /// because a row is only taken deliberately, with ↑/↓ onto a row that is on screen.
    @Published private(set) var historyHits: [String] = []
    /// The caret the list was asked for. A candidate's `replace` counts code points
    /// backwards from exactly this position, so it is part of the answer, not context.
    private var candidatesCaret = 0

    /// Whether the list still describes the line as the caret stands in it.
    ///
    /// False for the moment between moving the caret and the answer for the new
    /// position arriving. Nothing may be applied from a stale list: `replace` would cut
    /// the wrong code points, and the result would be a line that was never shown.
    private var candidatesAreFresh: Bool { candidatesCaret == min(caret, typed.unicodeScalars.count) }
    /// Which row Enter would take. 0 = the line as typed.
    @Published private(set) var selected = 0
    /// Magic-name handle the daemon offers for this line, or "".
    @Published private(set) var handle = ""

    /// The whole list under the prompt: completions, history, directories.
    ///
    /// Computed rather than stored, so it cannot describe a line that has moved on.
    /// Every source it reads is published, so a view watching this model re-renders on
    /// any of them.
    var suggestions: [Suggestions.Row] {
        Suggestions.rows(
            completions: candidates,
            history: historyHits,
            directories: directories,
            typed: typed,
            cwd: cwd
        )
    }

    var selectedSuggestion: Suggestion? {
        let rows = suggestions
        return rows.indices.contains(selected) ? rows[selected].suggestion : nil
    }

    /// The candidate the ghost shows and Tab applies — only on a completion row.
    ///
    /// Nil on the other two kinds, and that makes the ghost fall silent by itself: a
    /// ghost promises "this gets appended", and both a history hit and a directory
    /// break that promise. One replaces the line, the other puts no text in it at all.
    var current: Candidate? {
        guard case let .completion(candidate) = selectedSuggestion else { return nil }
        return candidate
    }

    /// Computed rather than stored, so moving the selection cannot leave a ghost
    /// behind that belongs to a different row.
    ///
    /// Only with the caret at the end: a ghost is drawn after the caret, so from the
    /// middle of a line it would appear to continue text it does not continue.
    var ghost: String {
        guard caret == typed.unicodeScalars.count, let candidate = current else { return "" }
        return ghostText(for: candidate, line: typed, cursorCodePoints: caret)
    }

    /// How much of the ghost → would take. Drawn brighter than the rest, so the
    /// difference between → and Tab is visible instead of learned by pressing.
    var ghostChunkLength: Int {
        Self.firstChunk(of: ghost).unicodeScalars.count
    }

    /// One edit from the editor: text and caret together, because a prediction for
    /// the new text at the old caret is a prediction for a line that never existed.
    func edit(text: String, caret: Int) {
        let caretMoved = caret != self.caret
        self.caret = caret
        let before = typed
        typed = text
        // `typed`'s observer covers a text change; a caret that moved on its own has
        // no other trigger, and it changes what is being completed.
        if before == text, caretMoved { requestSuggestions() }
    }
    /// Every directory the daemon ranked, newest-and-most-used first. The chip row
    /// shows the head of it, the list filters all of it.
    @Published private(set) var directories: [Directory] = []
    /// The head of the ranking, one chip each.
    var chips: [Directory] { Array(directories.prefix(Self.chipLimit)) }
    /// The directory the prompt works in.
    ///
    /// Stored, and no longer derived from the chip row. A directory change can land
    /// anywhere, and landing in a subfolder the row does not list is the common case
    /// — it is the reason for being able to move at all.
    @Published private(set) var cwd = FileManager.default.homeDirectoryForCurrentUser.path
    @Published private(set) var status = "connecting…"
    /// Newest first. One is in front, the rest wait in the rail as badges.
    @Published private(set) var runs: [Run] = []
    /// Which run is in front, by id. Published here so the view that positions cards
    /// — which observes this model and not the individual runs — actually hears it.
    @Published private(set) var foregroundID: UUID?
    /// Whether the launcher (chips and prompt) is on screen. Badges stay visible
    /// either way — that is the point of sending a card away.
    @Published var launcherVisible = true
    /// The panel's current frame, so the view can convert screen positions into it.
    /// Owned here rather than passed in, because the hosting view has to see it
    /// change in the same update as the content that depends on it.
    @Published var panelFrame: CGRect = .zero
    /// Where everything sits. Republished rather than captured once, because
    /// unplugging a display changes every number in it — and the view that positions
    /// the cards has to hear about that, not just the window.
    @Published var layout = Layout()
    /// How tall the launcher's glass actually is.
    ///
    /// Measured rather than assumed: the launcher sits in a fixed box, generous
    /// enough for a confirmation card, but its glass hugs its content and hangs at
    /// the box's top edge. Positioning the card below the BOX left the unused
    /// remainder as a visible gap.
    @Published var launcherHeight: CGFloat = Layout.preferredLauncherSize.height
    /// A command held back for confirmation. Waiting rather than running is the
    /// whole point, so this is a state and not a callback.
    @Published private(set) var pending: PendingRun?
    /// Whether the gear panel replaces the candidate list. A view swap inside the
    /// same glass, not a second window — the panel keeps the keyboard it has.
    @Published private(set) var settingsVisible = false
    /// What `settings list` said, verbatim: the schema arrives over the wire and
    /// the panel renders it, so a new setting never needs Swift changes.
    @Published private(set) var settingRows: [SettingRow] = []
    /// Why the panel is empty, when it is. The panel used to guess ("is the
    /// daemon running?") while the status line below carried the real answer —
    /// the place the eye is looking should say it.
    @Published private(set) var settingsNote: String?

    struct PendingRun {
        let command: String
        let cwd: String
        let hazards: [Hazard]
        /// Carried through the confirmation so the badge can show it afterwards. Looked
        /// up once, when the command was submitted, rather than again on confirming.
        let handle: String
        /// The run a reload replaces, if this confirmation came from one. Its card is
        /// dropped only when the command actually starts — dropped with Escape instead,
        /// the output it was about to replace is still on screen.
        var replaces: UUID? = nil
    }

    /// Asks for the launcher back. Set by the Controller, which owns the window.
    ///
    /// A callback and not a flag the model flips, because showing the overlay takes
    /// the keyboard: it has to happen on a deliberate action and not as a side effect
    /// of some other model change, or a run finishing in the background would pull
    /// focus out of whatever the user was typing in.
    var onReveal: (() -> Void)?

    /// Asks for the overlay to go away. Set by the Controller for the same reason as
    /// `onReveal`: the window is not the model's to order around.
    ///
    /// Raised by a click on the panel where nothing is drawn — which is a click beside
    /// the overlay as far as the user is concerned, and everywhere else on this system
    /// that dismisses.
    var onDismiss: (() -> Void)?

    private var client: DaemonClient?
    /// Whether anything has placed the prompt yet. The top-ranked directory takes
    /// over on the first load and never again — a refresh runs on every open, and it
    /// must not drag the user back out of wherever they went.
    private var placed = false
    /// What `cd -` goes back to.
    private var previousCwd: String?
    /// Lines as they were before each accept. Deliberately small: this undoes
    /// accepts, it is not a general edit history.
    private var undoStack: [String] = []
    /// Set while an accept writes to `typed`, so its own write is not mistaken for
    /// the user typing.
    private var applyingAccept = false
    private var lastChangeWasAccept = false

    /// Index of the chip for the current directory, or nil once the prompt has moved
    /// somewhere the row does not list.
    ///
    /// Against the chips and not the whole ranking: the fortieth directory is in
    /// `directories` for the list to filter, and reporting index 39 as the active chip
    /// would highlight nothing while claiming something was highlighted.
    var selection: Int? { chips.firstIndex { $0.path == cwd } }

    struct Crumb: Identifiable, Equatable {
        let label: String
        let path: String
        var id: String { path }
    }

    /// The current directory as clickable components, home collapsed to `~`.
    ///
    /// Capped: the launcher is 1200 pt wide and a deep path would push the row past
    /// it. The leading `…` is clickable too and stands for one level above what is
    /// shown, which is where someone reaching for it wants to go anyway.
    var breadcrumb: [Crumb] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var crumbs: [Crumb]
        if cwd == home {
            crumbs = [Crumb(label: "~", path: home)]
        } else if cwd.hasPrefix(home + "/") {
            crumbs = [Crumb(label: "~", path: home)]
            var accumulated = home
            for part in cwd.dropFirst(home.count + 1).split(separator: "/") {
                accumulated += "/" + part
                crumbs.append(Crumb(label: String(part), path: accumulated))
            }
        } else {
            crumbs = [Crumb(label: "/", path: "/")]
            var accumulated = ""
            for part in cwd.split(separator: "/") {
                accumulated += "/" + part
                crumbs.append(Crumb(label: String(part), path: accumulated))
            }
        }
        let limit = 6
        guard crumbs.count > limit else { return crumbs }
        return [Crumb(label: "…", path: crumbs[crumbs.count - limit - 1].path)] + crumbs.suffix(limit)
    }

    // MARK: - Setup

    func connect() {
        Task {
            // Resolved rather than assumed to be on PATH: a bundled app inherits
            // launchd's, which holds nothing a version manager or Homebrew put
            // there. Everything downstream — the socket path, respawning a daemon —
            // uses this one answer.
            let tooling = await ToolPath.shared.resolve()
            let path: String
            do {
                path = try DaemonClient.resolveSocketPath(tooling: tooling)
            } catch {
                status = describe(error)
                await seedDirectories(reason: "no daemon")
                return
            }
            let client = DaemonClient(socketPath: path, tooling: tooling)
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
            await migrateLegacyHotkey(client)
            await loadDirectories(client)
        }
    }

    /// Called every time the overlay appears. After hours away the daemon has long
    /// since idled out, and the chip row would otherwise still show whatever it held
    /// before — or the seeded fallback from a failed start. The client respawns a
    /// daemon on its own, so this both heals the connection and refreshes what is on
    /// screen before the first keystroke rather than after it.
    func refresh() {
        guard let client else {
            // Nothing resolved when the app started. That can be transient — the
            // login-shell probe has a ceiling and an rc file loading a version manager
            // can hit it — so reopening tries again rather than leaving every ⌥Space a
            // silent no-op until the app is quit. Which is what the paragraph above
            // promised and this guard used to prevent.
            connect()
            return
        }
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
            let entries = try await client.cwds(limit: Self.cwdLimit)
            if entries.isEmpty {
                // Not an error: imported shell history carries no directory, so a
                // fresh install has genuinely learned none.
                await seedDirectories(reason: "nothing learned yet")
            } else {
                directories = entries.map { Directory(path: $0.path, learned: true) }
                seeded = false
                place(entries.first?.path)
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

    /// Whether the chip row shows a guess rather than what the daemon ranked.
    ///
    /// Only the seed reads it, and only to charge for itself once: the scan walks the
    /// home directory, and reopening the overlay retries the connection, so without
    /// this a machine that cannot reach a daemon paid for a `find` on every ⌥Space to
    /// arrive at the same answer.
    private var seeded = false

    private func seedDirectories(reason: String) async {
        guard !seeded else {
            status = "\(reason) — directories guessed from git repositories on disk"
            return
        }
        let paths = await DirectorySeed.gitRepositories(limit: Self.cwdLimit)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        directories = paths.isEmpty
            ? [Directory(path: home, learned: false)]
            : paths.map { Directory(path: $0, learned: false) }
        seeded = true
        place(directories.first?.path)
        status = "\(reason) — directories guessed from git repositories on disk"
    }

    /// Takes the top-ranked directory, but only until something has placed the
    /// prompt. Reopening the overlay leaves you where you were.
    private func place(_ path: String?) {
        guard !placed, let path else { return }
        cwd = path
        placed = true
    }

    // MARK: - Directory selection

    /// The hold-⌥ cycle. Wraps, like a window switcher.
    func selectNext() { step(by: 1) }
    func selectPrevious() { step(by: -1) }

    /// From a directory the row does not list there is no current chip to step from,
    /// so the cycle enters the row at the end it is heading towards.
    private func step(by offset: Int) {
        let chips = chips
        guard !chips.isEmpty else { return }
        guard let current = selection else {
            select(offset > 0 ? 0 : chips.count - 1)
            return
        }
        select((current + offset + chips.count) % chips.count)
    }

    /// ⌘1…⌘9. Out-of-range digits are ignored rather than clamped: jumping to a
    /// different chip than the one pressed would be worse than doing nothing.
    func select(digit: Int) -> Bool {
        let index = digit - 1
        guard chips.indices.contains(index) else { return false }
        select(index)
        return true
    }

    func select(_ index: Int) {
        let chips = chips
        guard chips.indices.contains(index) else { return }
        navigate(to: chips[index].path)
    }

    /// Moves the prompt. Everything that changes the working directory comes through
    /// here — a chip, a breadcrumb, a typed `cd`, or the directory a finished run
    /// left behind.
    func navigate(to path: String) {
        guard path != cwd else { return }
        previousCwd = cwd
        cwd = path
        placed = true
        // The prediction was for the previous directory, so it is now wrong — the
        // cwd boost is a big part of the ranking.
        requestSuggestions()
    }

    // MARK: - Suggestions

    /// Asks for everything the list shows. Two round trips, one after the other; the
    /// directories are already here and are filtered locally, so they cost none.
    private func requestSuggestions() {
        let line = typed
        guard let client else {
            candidates = []
            historyHits = []
            handle = ""
            return
        }
        // An empty line is asked for too, and it answers: the frecency ranking for
        // this directory, which is precisely what a launcher should open with. The
        // guard that used to sit here claimed the daemon would reject it — only an
        // empty cwd is rejected (`protocol.ts`), and throwing the answer away left
        // the overlay blank at the one moment it has the most to say.
        let cursor = min(caret, line.unicodeScalars.count)
        let cwd = cwd

        Task {
            await requestCompletions(client, line: line, cursor: cursor, cwd: cwd)
            await requestHistory(client, line: line, cwd: cwd)
        }
    }

    private func requestCompletions(
        _ client: DaemonClient, line: String, cursor: Int, cwd: String
    ) async {
        do {
            // 0 = everything the daemon ranked; its own `topN` caps that at 50.
            // Asking for a screenful instead would be a cap nobody can see: the
            // list would end without saying that it had been cut, and the 7th
            // candidate would simply not exist.
            let prediction = try await client.predict(
                line: line, cursorCodePoints: cursor, cwd: cwd, limit: 0
            )
            // The answer describes the line as it was when we asked. If the
            // user kept typing or switched directory, showing it would offer
            // text they never saw suggested for what is now on screen.
            guard line == typed, cwd == self.cwd else { return }
            handle = prediction.handleHint
            candidates = prediction.candidates
            candidatesCaret = cursor
            clampSelection()
            // A previous failure would otherwise stay on screen forever, since
            // nothing else ever clears it.
            if status != "ready" { status = "ready" }
        } catch let error as DaemonError where error.isWarming {
            // Normal right after a cold start; the next keystroke tries again.
            // Guarded on the directory as well as the line, exactly like the answer
            // above: ⌥-cycling asks again without touching the typed text, so a
            // late failure for the directory the user just left would otherwise
            // clear the list that had already arrived for the one they are on.
            guard line == typed, cwd == self.cwd else { return }
            candidates = []
        } catch {
            guard line == typed, cwd == self.cwd else { return }
            candidates = []
            status = describe(error)
        }
    }

    /// The history section, in a second round trip.
    ///
    /// Deliberately after the prediction rather than beside it: the ghost hangs on
    /// `predict`, and a fuzzy match over the whole history must not be what delays a
    /// keystroke. Ordering them costs nothing anyway — the socket carries one request at
    /// a time by construction, so asking concurrently would only reshuffle the queue.
    private func requestHistory(_ client: DaemonClient, line: String, cwd: String) async {
        do {
            let hits = try await client.search(query: line, cwd: cwd, limit: Self.historyLimit)
            guard line == typed, cwd == self.cwd else { return }
            historyHits = hits
            clampSelection()
        } catch {
            // Quiet on purpose, and this is the one place where that is right: anything
            // worth reporting — a dead socket, a warming predictor — just happened to the
            // prediction on the same connection, and the status line already says so.
            // Saying it twice would replace the useful message with the vaguer one.
            guard line == typed, cwd == self.cwd else { return }
            historyHits = []
        }
    }

    /// A shorter list must not leave the selection pointing past its end. Both answers
    /// change the list's length, so both call this.
    private func clampSelection() {
        selected = min(selected, max(0, suggestions.count - 1))
    }

    /// ↑/↓ through the list. Wraps, and reports whether it did anything so the key
    /// can fall through to the caret when there is nothing to move through.
    @discardableResult
    func moveSelection(by offset: Int) -> Bool {
        let count = suggestions.count
        guard count > 1 else { return false }
        selected = (selected + offset + count) % count
        return true
    }

    /// Clicking a row does what Enter on it does — which is not the same thing for all
    /// three kinds. A command is filled in, a directory is gone to.
    func choose(_ index: Int) {
        let rows = suggestions
        guard rows.indices.contains(index) else { return }
        selected = index
        if case let .directory(directory) = rows[index].suggestion {
            move(to: directory)
            return
        }
        _ = acceptCurrent()
    }

    // MARK: - Actions

    /// Tab and →.
    ///
    /// Applies the candidate, which is not the same as appending the ghost: the
    /// candidate REPLACES the last `replace` code points of the line. That is what
    /// lets `doc` become `Documents/` rather than `docDocuments/`, and what lets a
    /// magic handle become the command it stands for. The old version appended the
    /// ghost, so anything without a ghost could not be accepted at all.
    func acceptCurrent() -> Bool {
        switch selectedSuggestion {
        case let .completion(candidate):
            return accept(candidate)
        case let .history(line):
            return acceptWholeLine(line)
        case .directory, nil:
            // Nothing to insert. Tab therefore steps past a directory row rather than
            // taking it — moving the prompt is not something a typing key should do,
            // and Enter and a click are both there for it.
            return false
        }
    }

    private func accept(_ candidate: Candidate) -> Bool {
        // Moving the caret alone asks for a new list but leaves the old one standing
        // until the answer arrives, and `replace` counts backwards from the caret the
        // daemon was asked about. Splicing the old list against the new caret produced a
        // line that was never on screen: `cd doc` with `Documents/` at replace 3, caret
        // dragged back to 3, Tab — `Documents/doc`. `ghostText` heals itself with a
        // prefix check against the text it claims to continue; this has to be told.
        guard candidatesAreFresh else { return false }
        let next = acceptedLine(for: candidate, line: typed, caret: caret)
        guard next != typed else { return false }
        apply(next, caret: acceptedCaret(for: candidate, line: typed, caret: caret))
        return true
    }

    /// A history hit is the whole line, so it takes the whole line — including whatever
    /// stands behind the caret.
    ///
    /// No freshness guard, and none is needed: `replace` arithmetic is what can go stale
    /// against a moved caret, and there is none here. The hit was matched against the
    /// line, not against the position in it.
    private func acceptWholeLine(_ line: String) -> Bool {
        guard line != typed else { return false }
        apply(line, caret: line.unicodeScalars.count)
        return true
    }

    /// Goes where a directory row points, and clears the line that found it — the query
    /// was a way to name the place, and leaving `fron` at the prompt afterwards would
    /// leave it there as a command.
    private func move(to directory: Directory) {
        clearLine()
        navigate(to: directory.path)
        status = "ready"
    }

    /// Tab: accept, or step to the next candidate when there is nothing left to accept.
    ///
    /// The double meaning Tab has in the REPL (`prompt-state.ts:163`), and it is what
    /// makes the key useful on a command already typed out in full — there is nothing to
    /// insert, so the only thing left to do with it is offer the next one.
    ///
    /// Here rather than in the view: it is a rule about candidates, and every other key
    /// the view maps hands off to exactly one method.
    @discardableResult
    func tab() -> Bool {
        if acceptCurrent() { return true }
        moveSelection(by: 1)
        return true
    }

    /// → : one chunk instead of the whole suggestion.
    ///
    /// Approximated off the ghost exactly the way the plugin does
    /// (`tabcat.plugin.zsh:667`): leading whitespace, the word, the whitespace after
    /// it. Not the real lexer — that lives in TypeScript, and a third language
    /// reimplementing it would be a third thing to keep in step. The plugin settled
    /// for the same approximation for the same reason.
    ///
    /// Only where a ghost exists. A candidate that corrects the spelling or expands a
    /// handle REPLACES what was typed, and half a replacement is not a smaller
    /// replacement, it is a broken line. Those Tab still takes whole, and → falls
    /// through to moving the caret — again what the plugin does.
    func acceptChunk() -> Bool {
        let chunk = Self.firstChunk(of: ghost)
        guard !chunk.isEmpty else { return false }
        // A ghost only ever exists with the caret at the end, so appending IS
        // inserting at the caret.
        apply(typed + chunk, caret: caret + chunk.unicodeScalars.count)
        return true
    }

    /// Leading whitespace, then the word, then the whitespace that follows it.
    static func firstChunk(of ghost: String) -> String {
        var index = ghost.startIndex
        func skip(while matches: (Character) -> Bool) {
            while index < ghost.endIndex, matches(ghost[index]) { index = ghost.index(after: index) }
        }
        skip { $0.isWhitespace }
        skip { !$0.isWhitespace }
        skip { $0.isWhitespace }
        return String(ghost[ghost.startIndex..<index])
    }

    /// ⇧Tab: back to before the last accept.
    ///
    /// Its own stack rather than the field's ⌘Z, which does not see a change made
    /// through the binding at all — and which would undo typing, not accepting.
    func undoAccept() -> Bool {
        guard let previous = undoStack.popLast() else { return false }
        applyingAccept = true
        caret = previous.unicodeScalars.count
        typed = previous
        applyingAccept = false
        lastChangeWasAccept = false
        return true
    }

    /// Writes an accepted line and remembers what it replaced.
    private func apply(_ next: String, caret nextCaret: Int) {
        undoStack.append(typed)
        applyingAccept = true
        caret = nextCaret
        typed = next
        applyingAccept = false
        lastChangeWasAccept = true
    }

    func submit() {
        // A held-back command must not be confirmable with Enter, so Enter cannot
        // mean "start something new" while one is waiting either — that would hide
        // the question behind a fresh prompt.
        if pending != nil {
            status = "⌘Enter to run it, Escape to drop it"
            return
        }
        // A directory row moves the prompt, on the FIRST Enter and at any index.
        //
        // The two-stage Enter exists so that nothing starts before it is visible, and
        // nothing starts here: navigation makes no card, needs no confirmation and `cd -`
        // takes it back (Phase 0c). Above that, the row of chips moves on a single click
        // — a row that needed two would contradict the row directly above it.
        //
        // At any index, because a directory row is never "the line as typed": the rule
        // below leaves index 0 to the typed line, and on a query that only matched a
        // directory that would have run the query as a command instead of going there.
        if case let .directory(directory) = selectedSuggestion {
            move(to: directory)
            return
        }

        // Enter on a row reached with ↑/↓ fills the line instead of running it, so
        // what is about to run is always visible before it does. Only reachable on
        // purpose: every edit puts the selection back on the top row. Before the
        // empty check, because the list on an empty line is the whole point of
        // opening the overlay with something on screen.
        if selected > 0 {
            // A refused accept on a stale list must not fall through to running the
            // typed line: the user chose a row, and running something else instead of
            // filling it in is the one outcome the two-stage Enter exists to prevent.
            // Waiting is safe, the fresh list is one round trip away.
            if acceptCurrent() || !candidatesAreFresh { return }
        }

        let line = typed
        guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return }

        // A line that only moves is not a run. It has no output worth a card, and it
        // used to produce an empty one while changing nothing at all: every run gets
        // its own shell, so the `cd` died with it.
        if let outcome = Navigation.outcome(for: line, in: cwd, previous: previousCwd) {
            switch outcome {
            case let .move(path):
                clearLine()
                navigate(to: path)
                status = "ready"
            case let .missing(path):
                // The line stays, so a typo can be corrected instead of retyped.
                status = path == "-" ? "no directory to go back to" : "no such directory: \(path)"
            }
            return
        }

        clearLine()

        // Captured before the await, not read after it. Resolving a handle is a round
        // trip to the daemon, and a background run finishing in that window can move
        // the prompt — the command would then have started somewhere other than where
        // it was typed. The prediction path already guards the same way.
        Task { [line, cwd] in
            // Scanned AFTER handle expansion: `@deploy` says nothing about what it
            // does, and the expansion is what actually runs.
            let resolution = await resolved(line, cwd: cwd)
            let command = resolution.command
            let hazards = HazardScan.scan(command: command, cwd: cwd)
            if hazards.isEmpty {
                start(command: command, cwd: cwd, handle: resolution.handle)
            } else {
                pending = PendingRun(
                    command: command, cwd: cwd, hazards: hazards, handle: resolution.handle
                )
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
        if let id = pending.replaces, let old = runs.first(where: { $0.id == id }) {
            dismiss(old)
        }
        start(command: pending.command, cwd: pending.cwd, handle: pending.handle)
    }

    func discardPending() {
        guard pending != nil else { return }
        pending = nil
        status = "dropped"
    }

    private func start(command: String, cwd: String, handle: String = "") {
        // Whatever was in front moves to the rail rather than being replaced. The
        // previous version refused a second command outright, which for a launcher
        // built around quick one-offs meant waiting out `npm test` doing nothing.
        // Nothing has to be demoted: exactly one id is in front, by construction.
        let run = Run(command: command, cwd: cwd, handle: handle)
        runs.insert(run, at: 0)
        foregroundID = run.id
        // Oldest first out of the rail, but only what has already finished. The
        // previous version took the last run whatever it was and terminated it, so
        // starting a sixth command killed the first — silently, with nothing left on
        // screen to say it had ever run. Work in progress is never evicted; the rail
        // grows instead, and only the user's own close ends a running command.
        while runs.count > Layout.railCapacity + 1,
              let finished = runs.lastIndex(where: { $0.state != .running }) {
            runs.remove(at: finished)
        }
        // `run` weakly, or nothing is ever freed: the run owns the process delegate,
        // the delegate owns this closure, and a strong `run` here closes the ring —
        // every command ever launched would stay alive, terminal buffer and all, for
        // the life of the app.
        run.start { [weak self, weak run] code in
            guard let self else { return }
            if let code {
                self.report(line: command, cwd: cwd, exitCode: code)
            } else {
                // The command ran but the terminal could not tell us how it ended.
                // Reporting 0 would teach the model it succeeded, which is a guess
                // dressed as a fact — better to learn nothing.
                self.status = "exit code unknown, not learned"
            }
            guard let run else { return }
            self.adoptDirectory(from: run)
            self.autoDismiss(run, code: code)
        }
    }

    /// Takes over wherever a finished run left the shell.
    ///
    /// This is what moves the prompt for `cd x && make`, `z api`, `pushd`, or any
    /// wrapper defined in an rc file — none of which reading the line could have
    /// recognised. `Navigation` only shortcuts the cases that deserve no card at all.
    ///
    /// Only when the prompt is still where the run started, so a background command
    /// finishing cannot yank the user out of wherever they moved on to.
    private func adoptDirectory(from run: Run) {
        guard let ended = run.finalCwd, ended != run.cwd, cwd == run.cwd else { return }
        navigate(to: ended)
    }

    /// A clean run gets out of the way by itself; a failure stays, because an error
    /// nobody saw is the same as no error report at all.
    private func autoDismiss(_ run: Run, code: Int32?) {
        guard code == 0 else { return }
        Task {
            try? await Task.sleep(for: .seconds(4))
            guard runs.contains(where: { $0 === run }) else { return }
            // Still in front means it is being read; leave it alone.
            guard foregroundID != run.id else { return }
            dismiss(run)
        }
    }

    // MARK: - Foreground and rail

    var foreground: Run? { runs.first { $0.id == foregroundID } }
    var badges: [Run] { runs.filter { $0.id != foregroundID } }

    /// Where a run sits right now.
    func presentation(of run: Run) -> Run.Presentation {
        run.id == foregroundID ? .foreground : .badge
    }

    /// Sends the run in front to the rail. This is the gesture the whole overlay was
    /// designed around: the output does not matter right now, put it away.
    ///
    /// Reports whether there was anything to put away, so Escape can use it as a rung:
    /// a card in front is put away first, and only an Escape with nothing left to
    /// tidy means the whole overlay.
    @discardableResult
    func minimizeForeground() -> Bool {
        guard foregroundID != nil else { return false }
        foregroundID = nil
        return true
    }

    /// Brings a badge back to the front, and the current front to the rail.
    ///
    /// The launcher comes back with it. Not a convenience: a foreground card is
    /// positioned underneath the launcher, and with the launcher hidden the panel has
    /// shrunk to the rail — the card was being placed several hundred points outside
    /// the window and clipped away. Clicking a badge made it vanish and put nothing in
    /// its place.
    func bringToFront(_ run: Run) {
        foregroundID = run.id
        if !launcherVisible { onReveal?() }
    }

    /// Drops every run that has finished, whatever its exit code.
    ///
    /// The automatic cleanup deliberately spares failures — an error nobody saw is
    /// the same as no error at all. An explicit key is the other case: the user is
    /// looking at them and saying away. Anything still running stays, which is the
    /// whole reason the rail outlives the launcher.
    func dismissFinished() {
        for run in runs where run.state != .running {
            dismiss(run)
        }
    }

    func dismiss(_ run: Run) {
        run.terminate()
        if foregroundID == run.id { foregroundID = nil }
        runs.removeAll { $0 === run }
    }

    /// Runs a finished run's command again, where it originally ran.
    ///
    /// Through the same gate as Enter: rescanned, and a hazardous command waits for
    /// ⌘Enter like a typed one — a reload is one click, which is exactly the accident
    /// the confirmation exists to catch. No round trip though: the stored command is
    /// already handle-expanded, and the handle came with it.
    ///
    /// Replace, not accumulate: the old card goes when the new run starts, or the rail
    /// would fill with copies of the same command and evict real history.
    ///
    /// Only for a finished run. On a running one "again" is ambiguous — kill it first,
    /// or run beside it? — and the button is not offered there either.
    func rerun(_ run: Run) {
        guard run.state != .running else { return }
        // Same rule as submit: a held-back command must be answered, not buried
        // under the next thing to start.
        if pending != nil {
            status = "⌘Enter to run it, Escape to drop it"
            return
        }
        let hazards = HazardScan.scan(command: run.command, cwd: run.cwd)
        if hazards.isEmpty {
            dismiss(run)
            start(command: run.command, cwd: run.cwd, handle: run.handle)
        } else {
            pending = PendingRun(
                command: run.command, cwd: run.cwd, hazards: hazards, handle: run.handle,
                replaces: run.id
            )
            status = "⌘Enter to run it, Escape to drop it"
        }
        // The new run goes to the front, and the front sits under the launcher — with
        // the launcher hidden the panel has shrunk to the rail and the card would be
        // clipped away. Same reason `bringToFront` reveals; the confirmation card
        // lives in the launcher too.
        if !launcherVisible { onReveal?() }
    }

    /// ⌘R: the front card again. False when nothing finished is in front, so the
    /// keystroke falls through instead of being swallowed.
    @discardableResult
    func rerunForeground() -> Bool {
        guard let run = foreground, run.state != .running else { return false }
        rerun(run)
        return true
    }

    /// Expands a magic-name handle to the command it stands for. The daemon owns
    /// that mapping, so it is asked rather than guessed; anything else runs as typed.
    ///
    /// The handle is typed bare, the way it is in the REPL (`prompt-state.ts:453`)
    /// and in the plugin's accept-line widget. The `@handle` form this replaces was
    /// invented only because the ordinary path did not work — a syntax that existed
    /// nowhere else in tabcat, to reach a feature that was already there.
    ///
    /// A whole line or nothing: `lint --fix` is a command that happens to start with
    /// a word that is also a handle, and expanding it would splice the arguments onto
    /// something else entirely.
    ///
    /// Returns the handle alongside the command, because the badge in the rail wants it
    /// and this is where it is known for free. Two ways to arrive at one:
    ///
    /// - the line WAS the handle, and expanding it is the proof
    /// - the line was typed out in full and the daemon happens to have a name for it
    ///
    /// The second is a reverse lookup, so it costs one more round trip — paid on Enter,
    /// which is the one keystroke that already waits for the daemon, and never on the
    /// typing path.
    private func resolved(_ line: String, cwd: String) async -> (command: String, handle: String) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let client, !trimmed.isEmpty else { return (line, "") }

        if !trimmed.contains(" ") {
            do {
                let rows = try await client.request(op: "names", fields: ["resolve", cwd, trimmed, ""])
                let expansion = rows[0].count > 2 ? rows[0][2] : ""
                if !expansion.isEmpty { return (expansion, trimmed) }
            } catch {
                return (line, "")
            }
        }
        return (line, await handle(for: line, cwd: cwd, client: client))
    }

    /// What the daemon calls this command here, or "" if it has no name for it.
    ///
    /// Asked rather than remembered: names are created from the REPL and the plugin too,
    /// and a handle added there should show up on the next run without the overlay
    /// having been restarted. Compared on the whole line, the same way `names create`
    /// stores it — a name stands for a command, not for a prefix of one.
    ///
    /// `names list` is sorted by handle, so two handles for the same command resolve to
    /// the first alphabetically. Deterministic beats picking whichever came back first.
    private func handle(for command: String, cwd: String, client: DaemonClient) async -> String {
        let trimmed = command.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return "" }
        do {
            // Four fields, padded: `names` is a fixed seven on the wire counting op, id
            // and protocol (`protocol.ts`, FIELD_COUNT), and a short line comes back
            // `bad_fields` — which this method would have swallowed into "no handle".
            let rows = try await client.request(op: "names", fields: ["list", cwd, "", ""])
            // Row 0 is the header; the rest is handle, line.
            for row in rows.dropFirst() where row.count > 1 && row[1] == trimmed {
                return row[0]
            }
        } catch {
            return ""
        }
        return ""
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
            foregroundID = nil
        } else {
            dismiss(run)
        }
    }

    func clear() {
        clearLine()
    }

    private func clearLine() {
        caret = 0
        typed = ""
        handle = ""
        // The accept stack belongs to one line, exactly as it does in the plugin.
        undoStack.removeAll()
        lastChangeWasAccept = false
    }

    // MARK: - Settings

    /// The gear. Opening fetches fresh rows — the file may have been edited from
    /// the REPL or the CLI since the panel was last open.
    func toggleSettings() {
        if settingsVisible {
            closeSettings()
            return
        }
        settingsVisible = true
        reloadSettings()
    }

    func closeSettings() {
        settingsVisible = false
    }

    /// `set` and `reset` both end in a fresh `list` rather than patching the row
    /// locally: the daemon owns effective value and overridden flag, and one
    /// source of truth beats a cheap optimisation on a click-rate interaction.
    func updateSetting(key: String, value: String) {
        change(key: key) { try await $0.settingsSet(key: key, value: value) }
    }

    func resetSetting(key: String) {
        change(key: key) { try await $0.settingsReset(key: key) }
    }

    private func change(key: String, _ operation: @escaping (DaemonClient) async throws -> String) {
        guard let client else { return }
        Task {
            do {
                _ = try await operation(client)
                settingRows = try await client.settingsList()
            } catch let error as DaemonError {
                // The daemon says why (`bad_value` carries the expectation) —
                // that message is more useful than a generic failure.
                status = "\(key): \(error.message)"
            } catch {
                status = describe(error)
            }
        }
    }

    private func reloadSettings() {
        guard let client else {
            settingsNote = "settings need a running daemon"
            return
        }
        Task {
            do {
                settingRows = try await client.settingsList()
                settingsNote = settingRows.isEmpty ? "the daemon reported no settings" : nil
            } catch let error as DaemonError where error.code == "bad_op" {
                settingsNote = "this daemon predates the settings op — `tabcat daemon stop`, the next request starts a fresh one"
            } catch {
                settingsNote = describe(error)
            }
        }
    }

    /// One-time move of the legacy `defaults write … hotkey` into settings.json,
    /// at connect rather than when the gear opens: the gear panel edits the file,
    /// so two stores answering one question showed the schema default while the
    /// legacy combination was the one in force. Only when the file has no value
    /// yet, and only when the legacy string means one of the schema's options —
    /// otherwise the legacy chain keeps deciding at startup and the row keeps
    /// showing the default. The legacy key is deleted afterwards: were it kept,
    /// a reset in the panel would silently re-migrate it at the next start,
    /// and reset means default.
    private func migrateLegacyHotkey(_ client: DaemonClient) async {
        let defaults = UserDefaults.standard
        guard let legacy = defaults.string(forKey: "hotkey") else { return }
        guard let rows = try? await client.settingsList(),
              let row = rows.first(where: { $0.key == "gui.hotkey" }),
              !row.options.isEmpty
        else { return }
        if !row.overridden {
            // Unmatched (a combination outside the fixed list) or the write
            // failed: keep the legacy key — it is what makes that combination
            // work at all, and deleting it would change the hotkey underfoot.
            guard let option = HotKeyCombo.matchingOption(for: legacy, in: row.options),
                  (try? await client.settingsSet(key: "gui.hotkey", value: option)) != nil
            else { return }
            Log.app.info("hotkey migrated from defaults: \(legacy, privacy: .public) -> \(option, privacy: .public)")
        }
        // Migrated — or the file already had a value that outranks it. Either
        // way the file is the store now, and the stale key would only
        // shadow-resurrect on some future reset, where reset means default.
        defaults.removeObject(forKey: "hotkey")
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
