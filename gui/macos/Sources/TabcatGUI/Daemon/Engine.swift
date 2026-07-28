import Foundation

struct Candidate {
    let insert: String
    let display: String
    let source: String
    let magicName: String
    /// How many code points before the cursor this candidate replaces.
    let replace: Int
}

struct Prediction {
    let prefix: String
    /// Magic-name handle the daemon suggests as a badge, or "".
    let handleHint: String
    let candidates: [Candidate]
}

struct CwdEntry {
    let path: String
    let score: Double
    let lastUsed: Date
}

extension DaemonClient {
    /// `predict <limit> <cursor> <cwd> <line>`. The cursor is counted in CODE
    /// POINTS, not UTF-16 units — the daemon converts, and sending Swift's
    /// `utf16.count` would shift every offset in a line containing an emoji.
    func predict(line: String, cursorCodePoints: Int, cwd: String, limit: Int) async throws -> Prediction {
        let rows = try await request(op: "predict", fields: [
            String(limit), String(cursorCodePoints), cwd, line,
        ])
        let header = rows[0]
        let candidates = rows.dropFirst().compactMap { row -> Candidate? in
            guard row.count >= 5 else { return nil }
            return Candidate(
                insert: row[0],
                display: row[1],
                source: row[2],
                magicName: row[3],
                replace: Int(row[4]) ?? 0
            )
        }
        return Prediction(
            prefix: header.count > 2 ? header[2] : "",
            handleHint: header.count > 3 ? header[3] : "",
            candidates: candidates
        )
    }

    /// `search <limit> <cwd> <query>` — fuzzy history, substring ranked above
    /// subsequence and the more recent hit first. Literally the same ranking as the
    /// REPL's ^R: `engine-host.ts` calls the `fuzzySearch` the REPL's own search uses.
    ///
    /// This is what `predict` cannot answer. Predictions match a PREFIX, so a typed
    /// `test` never reaches `npm test`; a search matches anywhere in the line.
    ///
    /// One field per row, the line and nothing else. `cwd` is on the wire and the
    /// daemon ignores it — history search is deliberately global, which is what makes
    /// it the answer to "I ran this somewhere else last week".
    func search(query: String, cwd: String, limit: Int) async throws -> [String] {
        let rows = try await request(op: "search", fields: [String(limit), cwd, query])
        return rows.dropFirst().compactMap(\.first).filter { !$0.isEmpty }
    }

    /// `forget <line>` — removes every occurrence of the line from the history
    /// and rebuilds the daemon's model. Returns how many entries went; 0 means
    /// the line was not there, which the status line should say instead of
    /// pretending a deletion happened.
    func forget(line: String) async throws -> Int {
        let rows = try await request(op: "forget", fields: [line])
        guard let header = rows.first, header.count > 2 else { return 0 }
        return Int(header[2]) ?? 0
    }

    /// `cwds <limit>` — the directories worked in, ranked by frecency. Empty on a
    /// fresh install, because imported shell history carries no directory. The
    /// caller has to treat that as "seed your own list", not as "no directories".
    func cwds(limit: Int) async throws -> [CwdEntry] {
        let rows = try await request(op: "cwds", fields: [String(limit)])
        return rows.dropFirst().compactMap { row in
            guard row.count >= 3, let score = Double(row[1]), let millis = Double(row[2]) else { return nil }
            return CwdEntry(path: row[0], score: score, lastUsed: Date(timeIntervalSince1970: millis / 1000))
        }
    }
}

/// The line after accepting `candidate`.
///
/// The candidate REPLACES the last `replace` code points rather than being appended
/// to them. That is what lets `doc` become `Documents/` instead of `docDocuments/`,
/// and what lets a magic handle become the command it stands for — neither of which
/// a ghost can show, because a ghost is drawn after the caret and can only append.
/// Accepting therefore cannot go through the ghost, which is exactly the mistake
/// this replaces.
///
/// Mirrors `acceptedLine` in `src/daemon/server.ts` and `acceptedLineFor` in
/// `src/repl/app.tsx`; all three have to agree or the badge in one front end
/// promises what another does not deliver.
///
/// Code points, not UTF-16 units: that is the unit the daemon counts `replace` in,
/// and a line containing an emoji would otherwise be cut in the wrong place.
func acceptedLine(for candidate: Candidate, line: String, caret: Int) -> String {
    guard !candidate.display.isEmpty else { return line }
    let scalars = Array(line.unicodeScalars)
    let cursor = min(max(0, caret), scalars.count)
    let start = max(0, cursor - candidate.replace)
    return String(String.UnicodeScalarView(scalars[0..<start]))
        + candidate.display
        + String(String.UnicodeScalarView(scalars[cursor...]))
}

/// Where the caret lands after accepting — right after what was inserted.
func acceptedCaret(for candidate: Candidate, line: String, caret: Int) -> Int {
    let scalars = Array(line.unicodeScalars)
    let cursor = min(max(0, caret), scalars.count)
    let start = max(0, cursor - candidate.replace)
    return start + candidate.display.unicodeScalars.count
}

/// What to draw after the typed text, or "" for no ghost.
///
/// Ported from `_tabcat_ghost_for_candidate` in the zsh plugin, and it has to be:
/// the ghost is drawn AFTER the caret, so it can only ever append. A candidate
/// that *corrects* what was typed ("doc" -> "Documents/") therefore gets no ghost
/// at all — appending its remainder would render "docuMents"-style nonsense that
/// differs from what accepting actually inserts. Tab still offers it.
func ghostText(for candidate: Candidate, line: String, cursorCodePoints: Int) -> String {
    guard candidate.replace > 0 else { return candidate.display }

    let scalars = Array(line.unicodeScalars)
    let start = cursorCodePoints - candidate.replace
    guard start >= 0, cursorCodePoints <= scalars.count else { return "" }
    let typed = String(String.UnicodeScalarView(scalars[start..<cursorCodePoints]))

    guard candidate.display.hasPrefix(typed) else { return "" }
    return String(candidate.display.dropFirst(typed.count))
}
