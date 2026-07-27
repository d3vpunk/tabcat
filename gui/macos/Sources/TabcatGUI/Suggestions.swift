import Foundation

/// One row of the list, and what taking it means.
///
/// Three sources in ONE index space, because ↑/↓ has to cross a section boundary
/// without knowing there is one. A key that had to know would be the REPL's
/// `historyFilter` rebuilt here — one key, two lists, a rule to remember — and
/// getting rid of exactly that is the reason the list exists.
enum Suggestion {
    /// From `predict`. Completes or corrects the line, splicing at the caret.
    case completion(Candidate)
    /// From `search`. A whole line out of the history, matched ANYWHERE inside it.
    ///
    /// Taking it replaces the line rather than continuing it, which is why it is not
    /// a `Candidate` with a large `replace`: that counts backwards from the caret and
    /// keeps whatever stands behind it, and a fuzzy hit on the whole line is not an
    /// answer about the part in front of the cursor.
    case history(String)
    /// From `cwds`. Moves the prompt instead of putting text in it.
    case directory(Directory)
}

/// The list under the prompt: `predict`, `search` and `cwds` in one place.
///
/// This is what retires ^R and the history mode. In a terminal they exist because
/// there is one line and one key for two lists; here the three answers are three
/// sections of the same list, and nothing has to be switched on to reach one.
///
/// Sectioned rather than merged into a single ranking, and that is a decision and not
/// a stopgap: the three scores are not comparable. A command's frecency, a fuzzy
/// match's substring-over-subsequence score and a directory's frecency are different
/// units, so a merged order would be an order nobody can explain — including whoever
/// has to fix it later.
enum Suggestions {
    /// Section titles.
    ///
    /// The completions carry none: they are what the prompt line continues into, and a
    /// label above them would be naming the default. The other two get one, because
    /// they are the two places where the list stops answering the question the prompt
    /// asked and starts answering another.
    static let historyTitle = "history"
    static let directoriesTitle = "directories"

    /// Shortest token that may pull up directories. One letter matches a good half of
    /// the disk — a section that appears for everybody and helps nobody.
    static let directoryTokenFloor = 2

    struct Row: Identifiable {
        let suggestion: Suggestion
        /// Drawn above this row, or nil where the row continues the section above it.
        ///
        /// A property of the first row rather than a row of its own: a header that was
        /// a row would be something ↑/↓ can land on and Enter can take.
        let header: String?
        let index: Int
        var id: Int { index }
    }

    /// Completions, then history, then directories.
    ///
    /// That order is not cosmetic. Row 0 is what the ghost shows and Tab takes, so the
    /// section the prompt is actually completing has to come first — otherwise typing
    /// would be driven by a fuzzy history hit that replaces the line.
    static func rows(
        completions: [Candidate],
        history: [String],
        directories: [Directory],
        typed: String,
        cwd: String,
        home: String = PathLabel.home
    ) -> [Row] {
        var rows: [Row] = []

        func append(_ suggestions: [Suggestion], header: String?) {
            for (offset, suggestion) in suggestions.enumerated() {
                rows.append(Row(
                    suggestion: suggestion,
                    header: offset == 0 ? header : nil,
                    index: rows.count
                ))
            }
        }

        append(completions.map(Suggestion.completion), header: nil)
        append(
            historyLines(history, completions: completions, typed: typed).map(Suggestion.history),
            header: historyTitle
        )
        append(
            matching(directories, typed: typed, cwd: cwd, home: home).map(Suggestion.directory),
            header: directoriesTitle
        )
        return rows
    }

    /// History, minus what the rest of the list already says.
    ///
    /// The two sources overlap least where it matters and most where it does not.
    /// `predict` matches a PREFIX, so a typed `test` never brings up `npm test` — that
    /// hole is the whole reason this section exists. On an empty line they do meet:
    /// `predict` ranks `npm ` as a stem while `search` lists `npm test` in full, and
    /// there a duplicate row would be a row that teaches nothing.
    ///
    /// The line as typed goes too. It is already on screen, one line above.
    private static func historyLines(
        _ history: [String], completions: [Candidate], typed: String
    ) -> [String] {
        let offered = Set(completions.map(\.display))
        let line = typed.trimmingCharacters(in: .whitespaces)
        return history.filter { !$0.isEmpty && $0 != line && !offered.contains($0) }
    }

    /// Directories whose path contains what is being typed.
    ///
    /// The last token and not the whole line, so `cd fron` works — which is both the
    /// moment the section is wanted most and the moment a whole-line match would find
    /// nothing at all.
    ///
    /// Substring, and deliberately not the subsequence the history search uses: `tst`
    /// is a subsequence of nearly every path on a machine, and a list of fifteen
    /// directories filtered down to fourteen has filtered nothing. History can afford
    /// the looser rule because it ranks thousands of lines by recency first.
    ///
    /// Matched against the path as it is SHOWN, home collapsed to `~`, so what the eye
    /// reads and what the filter reads are the same string — otherwise typing `~/pro`
    /// would match nothing while `~/projects/tabby` sits there on screen.
    ///
    /// No cap: the filter is the cap. Where the row of chips shows five because five
    /// is what a row of chips fits, a bounded list here would be a cap nobody can see.
    private static func matching(
        _ directories: [Directory], typed: String, cwd: String, home: String
    ) -> [Directory] {
        guard let token = typed.split(whereSeparator: \.isWhitespace).last,
              token.count >= directoryTokenFloor else { return [] }
        let needle = token.lowercased()
        return directories.filter { directory in
            // Where the prompt already stands is not somewhere to go.
            directory.path != cwd
                && PathLabel.full(of: directory.path, home: home).lowercased().contains(needle)
        }
    }
}
