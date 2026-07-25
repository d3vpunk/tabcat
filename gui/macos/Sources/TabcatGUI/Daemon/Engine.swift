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
