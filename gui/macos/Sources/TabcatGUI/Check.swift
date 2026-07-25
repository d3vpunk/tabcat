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

        let path: String
        do {
            path = try DaemonClient.resolveSocketPath()
            line(true, "socket path: \(path)")
        } catch {
            line(false, "socket path: \(error)")
            return 1
        }

        let client = DaemonClient(socketPath: path, timeout: 2)

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

        if !exitStatus() { ok = false }
        if !hazards() { ok = false }

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
            ("npm test && rm -rf dist", true),
            ("git reset --hard origin/main", true),
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

    /// `--selftest`: proves a run reaches the model. Separate from `--check` because
    /// it APPENDS a history entry — point $TABCAT_SOCKET at a scratch daemon.
    static func selftest() async -> Int32 {
        let path: String
        do {
            path = try DaemonClient.resolveSocketPath()
        } catch {
            line(false, "socket path: \(error)")
            return 1
        }
        let client = DaemonClient(socketPath: path, timeout: 2)
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
