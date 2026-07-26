import Foundation
import SwiftTerm

/// `TabcatGUI --check` — a headless preflight, in the spirit of
/// `tabcat plugin init zsh --check`.
///
/// The overlay is an LSUIElement app with nowhere to print, so when the wire
/// format, the socket path or the daemon version is wrong there is no output to
/// look at. This exercises exactly the parts that talk to the daemon and says what
/// happened, line by line.
@MainActor
enum Check {
    static func run() async -> Int32 {
        var ok = true

        // Reported first, and reported even when it succeeds, because this is the
        // step that used to fail invisibly: a diagnostic runs from a terminal and
        // finds `tabcat` on PATH, while the bundled app it is diagnosing inherits
        // launchd's PATH and finds nothing. An absolute path here means the app will
        // find it too.
        // Reported because a hotkey that another application already owns fails
        // invisibly: both get notified, so the symptom is someone else's window.
        let combo = HotKeyCombo.configured()
        line(true, "hotkey: \(combo.description)\(combo.description == HotKeyCombo.fallback.description ? " (default)" : "")")

        let tooling = await ToolPath.shared.resolve()
        line(true, "tabcat binary: \(tooling.binary)")

        let path: String
        do {
            path = try DaemonClient.resolveSocketPath(tooling: tooling)
            line(true, "socket path: \(path)")
        } catch {
            line(false, "socket path: \(error)")
            return 1
        }

        let client = DaemonClient(socketPath: path, timeout: 2, tooling: tooling)

        do {
            let rows = try await client.request(op: "ping")
            let header = rows[0]
            // ok, id, version, protocol, state, pid
            let version = header.count > 2 ? header[2] : "?"
            let protocolVersion = header.count > 3 ? header[3] : "?"
            let state = header.count > 4 ? header[4] : "?"
            line(true, "daemon: version \(version), protocol \(protocolVersion), state \(state)")
            if protocolVersion != String(Wire.protocolVersion) {
                line(false, "protocol mismatch: this build speaks \(Wire.protocolVersion)")
                ok = false
            }
        } catch {
            line(false, "ping: \(error) — is a daemon running? `tabcat daemon`")
            return 1
        }

        do {
            let entries = try await client.cwds(limit: 5)
            if entries.isEmpty {
                // Not a failure: every imported history entry carries cwd null, so
                // a fresh install has genuinely learned no directory yet.
                line(true, "cwds: none learned yet (fresh install, or only imported history)")
            } else {
                line(true, "cwds: \(entries.count)")
                for entry in entries {
                    print(String(format: "        %8.2f  %@", entry.score, entry.path))
                }
            }
        } catch {
            line(false, "cwds: \(error)")
            ok = false
        }

        // A prediction for a line that any shell history contains, in a directory
        // the daemon has actually seen — otherwise a miss would look like a bug.
        do {
            let entries = try await client.cwds(limit: 1)
            let cwd = entries.first?.path ?? FileManager.default.homeDirectoryForCurrentUser.path
            let line0 = "g"
            let prediction = try await client.predict(
                line: line0,
                cursorCodePoints: line0.unicodeScalars.count,
                cwd: cwd,
                limit: 3
            )
            line(true, "predict \"\(line0)\" in \(cwd): \(prediction.candidates.count) candidate(s)")
            for candidate in prediction.candidates {
                let ghost = ghostText(for: candidate, line: line0, cursorCodePoints: line0.unicodeScalars.count)
                print("        display=\(candidate.display)  replace=\(candidate.replace)  ghost=\(ghost.isEmpty ? "(none)" : ghost)")
            }
            if !prediction.handleHint.isEmpty {
                print("        handle=\(prediction.handleHint)")
            }
        } catch let error as DaemonError where error.isWarming {
            line(true, "predict: daemon still warming — normal right after a cold start")
        } catch {
            line(false, "predict: \(error)")
            ok = false
        }

        // Always reported, not only when it would be used: this is the cold-start
        // path, and it would otherwise only surface on a fresh install — the one
        // moment nobody is watching a diagnostic. Which is exactly how the first
        // implementation shipped broken, using an mdfind that cannot see hidden
        // entries and therefore never found a single `.git`.
        let seed = await DirectorySeed.gitRepositories(limit: 5)
        if seed.isEmpty {
            line(false, "seed: no git repositories found under ~ — cold start would fall back to ~ alone")
        } else {
            line(true, "seed: \(seed.count) repositories, newest first")
            for path in seed { print("        \(path)") }
        }

        // Writes nothing anywhere: a command that only echoes, with a chosen exit code
        // so the whole chain — spawn, terminal, exit reporting — is exercised.
        let probe = await runInTerminal("echo tabcat-pty-ok; exit 3")
        let probeOK = probe.screen.contains("tabcat-pty-ok") && probe.code == 3
        line(probeOK, "terminal: exit \(probe.code.map(String.init) ?? "unknown"), marker on screen: \(probe.screen.contains("tabcat-pty-ok"))")
        if !probeOK { ok = false }

        // The regression a screenshot once found: a Symfony-style progress bar
        // arriving as a dozen bars side by side. The emulator owns this behaviour now,
        // but the case stays — it is the shape real commands emit, and proving it comes
        // out as ONE bar costs nothing.
        let bar = await runInTerminal(
            "printf 'step one\\n'; printf '\\033[1A\\033[1G\\033[2K'; printf 'step two\\n'"
        )
        // Compared against the whole screen, not with `contains`: the first attempt
        // asserted !contains("0%") against a screen reading "100%", which contains it.
        let barOK = bar.screen == "step two"
        line(barOK, barOK ? "progress bar redraws in place" : "progress bar did NOT overwrite: \(bar.screen.debugDescription)")
        if !barOK { ok = false }

        // The wrapper that carries a run's final directory back to the prompt. Proven
        // end to end and not just read, because a broken wrapper looks exactly like
        // the bug it replaced: a `cd` that appears to run and changes nothing.
        // `false` at the end so the exit code has to survive the report as well.
        let pwdFile = NSTemporaryDirectory() + "tabcat-cwd-probe"
        let target = URL(fileURLWithPath: NSTemporaryDirectory()).resolvingSymlinksInPath().path
        let moved = await runInTerminal(Run.wrapped(
            command: "cd \(target) && echo tabcat-cwd-ok && false",
            pwdFile: pwdFile
        ))
        let reported = (try? String(contentsOfFile: pwdFile, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        try? FileManager.default.removeItem(atPath: pwdFile)
        let landed = reported.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
        let cwdOK = moved.code == 1 && moved.screen.contains("tabcat-cwd-ok") && landed == target
        line(cwdOK, "run reports its final directory: \(landed ?? "nothing"), exit \(moved.code.map(String.init) ?? "unknown")")
        if !cwdOK { ok = false }

        // The other half of the same contract, and the one the wrapper's own comment
        // calls risky: a command that ends the shell itself never reaches the report,
        // and the prompt then has to stay where it was rather than move somewhere
        // half-written.
        let exitFile = NSTemporaryDirectory() + "tabcat-cwd-probe-exec"
        _ = await runInTerminal(Run.wrapped(command: "exit 0", pwdFile: exitFile))
        let silent = (try? String(contentsOfFile: exitFile, encoding: .utf8)) == nil
        try? FileManager.default.removeItem(atPath: exitFile)
        line(silent, silent
            ? "a command that exits the shell reports no directory"
            : "a command that exits the shell wrote a directory anyway")
        if !silent { ok = false }

        if tables() != 0 { ok = false }

        return ok ? 0 : 1
    }

    /// `--tables`: the pinned tables on their own, with no daemon and no pty.
    ///
    /// Split out so something automatic can run them. `--check` needs a daemon on a
    /// socket and a login shell that can find `tabcat`, and a build runner has neither
    /// — so six tables over pure functions, the only thing resembling a test the Swift
    /// side has, ran nowhere but on the author's machine when he remembered to ask.
    static func tables() -> Int32 {
        var ok = true
        if !exitStatus() { ok = false }
        if !hazards() { ok = false }
        if !accepting() { ok = false }
        if !chunking() { ok = false }
        if !navigation() { ok = false }
        if !layout() { ok = false }
        return ok ? 0 : 1
    }

    /// Exit-status decoding, as a table.
    ///
    /// Pinned because `exit 3` arrived as 768 and would have been learned as the exit
    /// code — the daemon accepts anything up to 4096, so nothing downstream would have
    /// objected.
    private static func exitStatus() -> Bool {
        let cases: [(reported: Int32, expected: Int32, why: String)] = [
            (0, 0, "success"),
            (3, 3, "already decoded"),
            (127, 127, "command not found, already decoded"),
            (768, 3, "raw status for exit 3"),
            (256, 1, "raw status for exit 1"),
            (0xFF00, 255, "raw status for exit 255"),
            (9, 9, "small value stays a code, not SIGKILL"),
            (SIGTERM, SIGTERM, "small value stays a code, not a signal"),
            (0x8000 + 15, 143, "raw status, killed by SIGTERM"),
        ]
        var wrong: [String] = []
        for probe in cases where ExitStatus.normalise(probe.reported) != probe.expected {
            wrong.append("\(probe.reported) -> \(ExitStatus.normalise(probe.reported)), want \(probe.expected) (\(probe.why))")
        }
        line(wrong.isEmpty, "exit status: \(cases.count - wrong.count)/\(cases.count) as expected")
        for problem in wrong { print("        \(problem)") }
        return wrong.isEmpty
    }

    /// The hazard heuristic, as a table.
    ///
    /// Written down rather than eyeballed because both failure directions are
    /// invisible in normal use: a missed `rm -rf` shows up as lost work, and a false
    /// alarm on `npm test` trains the user to confirm without reading.
    private static func hazards() -> Bool {
        // A real file, so the truncating-redirect rule has something to find.
        let existing = NSTemporaryDirectory() + "tabcat-hazard-probe"
        FileManager.default.createFile(atPath: existing, contents: Data())
        defer { try? FileManager.default.removeItem(atPath: existing) }

        let cases: [(command: String, dangerous: Bool)] = [
            ("rm -rf node_modules", true),
            ("rm -f secrets.env", true),
            ("rm /etc/hosts", true),
            ("rm *.log", true),
            ("sudo rm -rf /tmp/x", true),
            // A wrapper's own option used to resolve as the program, which matched no
            // case and turned the scan off for the segment.
            ("sudo -u root rm -rf /", true),
            ("find . -print0 | xargs -0 rm -rf ./build", true),
            ("npm test && rm -rf dist", true),
            ("git reset --hard origin/main", true),
            // git's globals come before the subcommand; `-C <dir>` put the directory
            // where every subcommand test looks.
            ("git -C /tmp reset --hard", true),
            ("git -c user.email=x push --force", true),
            ("git --no-pager clean -fd", true),
            ("git clean -fd", true),
            ("git push --force origin main", true),
            ("git branch -D feature", true),
            ("git checkout -- src/", true),
            ("dd if=/dev/zero of=disk.img", true),
            ("docker system prune -a", true),
            ("npm publish", true),
            ("psql -c 'drop table users'", true),
            ("kubectl delete pod api", true),
            ("echo hi > \(existing)", true),

            ("git status --short", false),
            ("npm run build", false),
            ("npm test", false),
            ("rm note.txt", false),
            ("git checkout main", false),
            ("git checkout -b feature", false),
            ("ls -la", false),
            ("docker compose up -d", false),
            ("echo hi >> \(existing)", false),
            ("echo hi > \(NSTemporaryDirectory())tabcat-not-there-yet", false),
            // A device is not a file worth saving. /dev/null exists and is not a
            // directory, so the old test warned about the commonest redirect there is.
            ("npm test > /dev/null 2>&1", false),
            ("echo hi > /dev/null", false),
            // The fallback that finds a program behind a wrapper's options must not
            // fire when the positional answer is a perfectly good program.
            ("echo rm -rf /", false),
            ("man rm", false),
        ]

        var wrong: [String] = []
        for probe in cases {
            let found = HazardScan.scan(command: probe.command, cwd: NSTemporaryDirectory())
            if found.isEmpty == probe.dangerous {
                wrong.append("\(probe.dangerous ? "missed" : "false alarm"): \(probe.command)")
            }
        }
        line(wrong.isEmpty, "hazards: \(cases.count - wrong.count)/\(cases.count) as expected")
        for problem in wrong { print("        \(problem)") }
        return wrong.isEmpty
    }

    /// The layout, against screens this machine may or may not have.
    ///
    /// Pinned because geometry fails silently and only on someone else's hardware:
    /// unplug an external display and everything is suddenly positioned for a screen
    /// that no longer exists. Two invariants matter — nothing may leave the visible
    /// area, and everything drawn must be inside the panel, because a panel clips
    /// and that is how a card brought back from the rail became invisible.
    private static func layout() -> Bool {
        let screens: [(name: String, rect: NSRect)] = [
            ("external 2560×1415", NSRect(x: 0, y: 0, width: 2560, height: 1415)),
            ("laptop 1512×944", NSRect(x: 0, y: 0, width: 1512, height: 944)),
            ("left of the main one", NSRect(x: -1920, y: 300, width: 1920, height: 1055)),
            ("short 1024×600", NSRect(x: 0, y: 0, width: 1024, height: 600)),
        ]

        var wrong: [String] = []
        for probe in screens {
            let layout = Layout(screen: probe.rect)
            let launcher = layout.launcher
            let card = layout.card(below: layout.launcherSize.height)
            let open = layout.panelOpen(badges: 0)
            let closed = layout.panelClosed(badges: 0)

            func check(_ condition: Bool, _ what: String) {
                if !condition { wrong.append("\(probe.name): \(what)") }
            }
            check(probe.rect.contains(launcher), "launcher \(launcher) leaves the screen")
            check(probe.rect.contains(card), "card \(card) leaves the screen")
            check(probe.rect.contains(layout.badge(0)), "first badge leaves the screen")
            check(probe.rect.contains(layout.badge(Layout.railCapacity - 1)), "last badge leaves the screen")
            check(abs(launcher.midX - probe.rect.midX) < 0.5, "launcher is not centred")
            check(open.contains(launcher), "launcher is outside the open panel")
            check(open.contains(card), "card is outside the open panel — it would be clipped")
            check(closed.contains(layout.badge(0)), "badge is outside the closed panel")

            // Past the reserved capacity, which is the entire reason `rail(badges:)`
            // takes a count: the rail grows rather than a run being dropped to keep it
            // short. Every probe used to ask for zero badges, so the one behaviour the
            // rail exists for was the one thing this table never looked at — a rail that
            // capped instead of growing would have passed, and the extra badges would
            // have been clipped away by the panel exactly like the bug that put this
            // table here.
            for crowded in [Layout.railCapacity + 1, Layout.railCapacity + 2] {
                let last = layout.badge(crowded - 1)
                check(layout.panelClosed(badges: crowded).contains(last),
                      "badge \(crowded - 1) of \(crowded) is outside the closed panel")
                check(layout.panelOpen(badges: crowded).contains(last),
                      "badge \(crowded - 1) of \(crowded) is outside the open panel")
            }
        }
        line(wrong.isEmpty, "layout: \(screens.count) screens, \(wrong.count) problem(s)")
        for problem in wrong { print("        \(problem)") }
        return wrong.isEmpty
    }

    /// What Tab does with a candidate, as a table.
    ///
    /// Pinned because the previous version accepted the GHOST, and a ghost is empty
    /// for exactly the two candidates worth accepting most: one that corrects the
    /// spelling, and a magic handle whose expansion is not a continuation of it.
    /// Both looked like a dead key. The rule has to agree with `acceptedLine` in
    /// `server.ts` and `acceptedLineFor` in `app.tsx` — three copies, one behaviour.
    private static func accepting() -> Bool {
        // caret is in code points; nil means "at the end of the line".
        let cases: [(line: String, caret: Int?, candidate: Candidate, expected: String, why: String)] = [
            ("git ch", nil, candidate("checkout develop", replace: 2), "git checkout develop",
             "history: the merge replaces the typed chunk"),
            ("doc", nil, candidate("Documents/", replace: 3), "Documents/",
             "corrects the spelling — the case a ghost cannot show"),
            ("lint", nil, candidate("npm run lint", replace: 4, magic: "lint"), "npm run lint",
             "a handle becomes its command, which starts with something else entirely"),
            ("g", nil, candidate("git", replace: 1), "git", "the ordinary continuation"),
            ("cd 🙂/do", nil, candidate("docs/", replace: 2), "cd 🙂/docs/",
             "code points: counting UTF-16 would eat the emoji's second half"),
            ("npm", nil, candidate("", replace: 3), "npm", "nothing offered, nothing changed"),
            ("ls", nil, candidate("ls", replace: 2), "ls", "already complete — Tab must not double it"),

            ("git ch --force", 6, candidate("checkout", replace: 2), "git checkout --force",
             "mid-line: what follows the caret survives"),
            ("git ch", 0, candidate("git", replace: 0), "gitgit ch",
             "caret at the start replaces nothing and keeps the whole line after it"),
            ("ab", 9, candidate("abc", replace: 2), "abc",
             "a caret past the end is clamped, not trusted"),
        ]

        var wrong: [String] = []
        for probe in cases {
            let caret = probe.caret ?? probe.line.unicodeScalars.count
            let actual = acceptedLine(for: probe.candidate, line: probe.line, caret: caret)
            if actual != probe.expected {
                wrong.append("\(probe.line.debugDescription)@\(caret) -> \(actual.debugDescription), want \(probe.expected.debugDescription) (\(probe.why))")
            }
        }
        line(wrong.isEmpty, "accepting: \(cases.count - wrong.count)/\(cases.count) as expected")
        for problem in wrong { print("        \(problem)") }
        return wrong.isEmpty
    }

    /// What → takes from a ghost, as a table.
    ///
    /// Pinned because it is an approximation of the lexer rather than the lexer, and
    /// the plugin approximates it the same way — if the two drift, → means something
    /// different in the shell than it does here, for the same suggestion.
    private static func chunking() -> Bool {
        let cases: [(ghost: String, expected: String, why: String)] = [
            ("eckout develop", "eckout ", "the word, plus the space that follows it"),
            (" develop", " develop", "leading space, then the word, then nothing"),
            (" -m 'note'", " -m ", "a flag is a word like any other"),
            ("it", "it", "no trailing space, so the whole rest"),
            (" ", " ", "whitespace only — take it rather than nothing"),
            ("", "", "no ghost, no chunk"),
            ("a  b", "a  ", "both spaces belong to the chunk before them"),
        ]
        var wrong: [String] = []
        for probe in cases {
            let actual = PromptModel.firstChunk(of: probe.ghost)
            if actual != probe.expected {
                wrong.append("\(probe.ghost.debugDescription) -> \(actual.debugDescription), want \(probe.expected.debugDescription) (\(probe.why))")
            }
        }
        line(wrong.isEmpty, "chunking: \(cases.count - wrong.count)/\(cases.count) as expected")
        for problem in wrong { print("        \(problem)") }
        return wrong.isEmpty
    }

    private static func candidate(_ display: String, replace: Int, magic: String = "") -> Candidate {
        Candidate(
            insert: "",
            display: display,
            source: magic.isEmpty ? "history" : "magic",
            magicName: magic,
            replace: replace
        )
    }

    /// Which lines move the prompt instead of becoming a run, as a table.
    ///
    /// Both directions hurt and neither is visible while it is happening. Treating a
    /// command as navigation would silently swallow it; treating a move as a command
    /// brings back the empty card that changed nothing, which is the bug this exists
    /// to remove. Directories that are genuinely there are needed for the bare-path
    /// rule, so the table works in a scratch tree rather than in the abstract.
    private static func navigation() -> Bool {
        let root = NSTemporaryDirectory() + "tabcat-nav-probe"
        let child = root + "/frontend"
        try? FileManager.default.createDirectory(atPath: child, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: root + "/build", contents: Data())
        defer { try? FileManager.default.removeItem(atPath: root) }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let previous = NSTemporaryDirectory()
        let cases: [(line: String, expected: Navigation.Outcome?, why: String)] = [
            ("cd frontend", .move(child), "the plain case"),
            ("frontend", .move(child), "a bare directory, no cd typed"),
            ("frontend/", .move(child), "with the slash completion adds"),
            ("cd .", .move(root), "resolves to where we already are"),
            ("cd", .move(home), "bare cd goes home"),
            ("cd -", .move((previous as NSString).standardizingPath), "back to the previous one"),
            ("cd \(child)", .move(child), "absolute"),
            ("cd frontend/..", .move(root), "'..' is resolved, not passed along"),
            ("cd nope", .missing(root + "/nope"), "says so instead of running it"),

            ("cd src*", nil, "a glob is for the shell to expand, not for us to fail on"),
            ("cd !$", nil, "history expansion likewise"),
            ("cd a{b,c}", nil, "brace expansion likewise"),

            ("build", nil, "a file is not a directory"),
            ("ls", nil, "a command that is not a directory here"),
            ("cd frontend && npm test", nil, "does more than move — a run, adopted afterwards"),
            ("cd a b", nil, "not a directory change we understand"),
            ("z frontend", nil, "a jump tool: run it, adopt its pwd"),
            ("echo cd", nil, "cd is not the program"),
            ("cd $(pwd)", nil, "substitution is not resolved here"),
            ("", nil, "nothing typed"),
        ]

        var wrong: [String] = []
        for probe in cases {
            let actual = Navigation.outcome(for: probe.line, in: root, previous: previous)
            if actual != probe.expected {
                wrong.append("\(probe.line.isEmpty ? "(empty)" : probe.line) -> \(describe(actual)), want \(describe(probe.expected)) (\(probe.why))")
            }
        }
        line(wrong.isEmpty, "navigation: \(cases.count - wrong.count)/\(cases.count) as expected")
        for problem in wrong { print("        \(problem)") }
        return wrong.isEmpty
    }

    private static func describe(_ outcome: Navigation.Outcome?) -> String {
        switch outcome {
        case nil: return "run"
        case let .move(path): return "move \(path)"
        case let .missing(path): return "missing \(path)"
        }
    }

    /// `--selftest`: proves a run reaches the model. Separate from `--check` because
    /// it APPENDS a history entry — point $TABCAT_SOCKET at a scratch daemon.
    static func selftest() async -> Int32 {
        let tooling = await ToolPath.shared.resolve()
        let path: String
        do {
            path = try DaemonClient.resolveSocketPath(tooling: tooling)
        } catch {
            line(false, "socket path: \(error)")
            return 1
        }
        let client = DaemonClient(socketPath: path, timeout: 2, tooling: tooling)
        let marker = "echo tabcat-selftest-\(Int(Date().timeIntervalSince1970))"
        let cwd = FileManager.default.homeDirectoryForCurrentUser.path

        let result = await runInTerminal(marker)
        line(result.code == 0, "ran: exit \(result.code.map(String.init) ?? "unknown")")
        guard let exitCode = result.code else {
            line(false, "no exit code, so there is nothing honest to learn")
            return 1
        }

        do {
            _ = try await client.request(op: "learn", fields: [
                String(exitCode), String(Int(Date().timeIntervalSince1970 * 1000)), cwd, marker,
            ])
            line(true, "learn accepted")
        } catch {
            line(false, "learn: \(error)")
            return 1
        }

        // The point of the whole exercise: the entry has to come back out of the
        // model, or overlay usage would never influence the ranking.
        do {
            let prefix = String(marker.prefix(12))
            let prediction = try await client.predict(
                line: prefix,
                cursorCodePoints: prefix.unicodeScalars.count,
                cwd: cwd,
                limit: 3
            )
            let learned = prediction.candidates.contains { marker.contains($0.display.trimmingCharacters(in: .whitespaces)) }
            line(learned, "predicted back: \(prediction.candidates.map(\.display))")
            let cwds = try await client.cwds(limit: 9)
            line(cwds.contains { $0.path == cwd }, "cwd now in the chip row: \(cwds.map(\.path))")
            return learned ? 0 : 1
        } catch {
            line(false, "read back: \(error)")
            return 1
        }
    }

    /// Collects the output on the delivery queue, so nothing is mutated from two
    /// places at once.
    /// Keeps the terminal alive for the duration of the call — a local that went out of
    /// scope would take its process with it.
    private final class Box {
        var terminal: HeadlessTerminal?
    }

    /// Runs a command through a real terminal with no view attached, and returns what
    /// the emulated screen ended up showing.
    ///
    /// `HeadlessTerminal` is the same emulator the cards use, which is what makes this
    /// worth running: it tests our spawning and the screen we would show, not a
    /// hand-rolled parser that no longer exists.
    private static func runInTerminal(_ command: String) async -> (screen: String, code: Int32?) {
        // NOT the main queue: this path runs without an NSApplication, so nothing
        // would ever drain it and the callbacks would never arrive.
        let queue = DispatchQueue(label: "nl.d3vpunk.tabcat.gui.check")
        let box = Box()

        let code: Int32? = await withCheckedContinuation { continuation in
            let terminal = HeadlessTerminal(queue: queue) { exitCode in
                continuation.resume(returning: exitCode)
            }
            box.terminal = terminal
            var environment = ProcessInfo.processInfo.environment
            environment["TABCAT_PLUGIN_NO_SETUP"] = "1"
            environment["TERM"] = "xterm-256color"
            terminal.process.startProcess(
                executable: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
                args: ["-ic", command],
                environment: environment.map { "\($0.key)=\($0.value)" },
                currentDirectory: FileManager.default.homeDirectoryForCurrentUser.path
            )
        }

        // Normalised here too, not only in Run: a diagnostic that reports something
        // other than what the app would report is worse than no diagnostic.
        let normalised = code.map(ExitStatus.normalise)
        guard let terminal = box.terminal?.terminal else { return ("", normalised) }
        let screen = (0..<terminal.rows)
            .compactMap { terminal.getLine(row: $0)?.translateToString(trimRight: true) }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (screen, normalised)
    }

    private static func line(_ good: Bool, _ text: String) {
        print("  \(good ? "ok  " : "FAIL") \(text)")
    }
}
