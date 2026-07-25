import Foundation

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
        // path, and a broken Spotlight query would otherwise only surface on a
        // fresh install — the one moment nobody is watching a diagnostic.
        let seed = await DirectorySeed.gitRepositories(limit: 5)
        if seed.isEmpty {
            line(false, "seed: mdfind found no git repositories under ~ — cold start would fall back to ~ alone")
        } else {
            line(true, "seed: \(seed.count) repositories, newest first")
            for path in seed { print("        \(path)") }
        }

        // Writes nothing anywhere: a command that only echoes, with a chosen exit
        // code so the 128+signal decoding is exercised too.
        let pty = await runInPTY("echo tabcat-pty-ok; exit 3")
        let ptyOK = pty.output.contains("tabcat-pty-ok") && pty.code == 3
        line(ptyOK, "pty: exit \(pty.code), output \(pty.output.isEmpty ? "(none)" : "\"\(pty.output.trimmingCharacters(in: .whitespacesAndNewlines))\"")")
        if !ptyOK { ok = false }

        return ok ? 0 : 1
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

        let result = await runInPTY(marker)
        line(result.code == 0, "ran: exit \(result.code)")

        do {
            _ = try await client.request(op: "learn", fields: [
                String(result.code), String(Int(Date().timeIntervalSince1970 * 1000)), cwd, marker,
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
    private final class Collector {
        var buffer = OutputBuffer()
    }

    private static func runInPTY(_ command: String) async -> (output: String, code: Int32) {
        // NOT the main queue: this path runs without an NSApplication, so nothing
        // would ever drain it and the callbacks would never arrive.
        let queue = DispatchQueue(label: "nl.d3vpunk.tabcat.gui.check")
        let collector = Collector()
        let pty = PTYProcess()

        return await withCheckedContinuation { continuation in
            let started = pty.spawn(
                command: command,
                cwd: FileManager.default.homeDirectoryForCurrentUser.path,
                deliverOn: queue,
                onOutput: { collector.buffer.append($0) },
                onExit: { code in
                    collector.buffer.finish()
                    continuation.resume(returning: (collector.buffer.text, code))
                }
            )
            if !started {
                continuation.resume(returning: ("could not open a pseudo terminal", -1))
            }
        }
    }

    private static func line(_ good: Bool, _ text: String) {
        print("  \(good ? "ok  " : "FAIL") \(text)")
    }
}
