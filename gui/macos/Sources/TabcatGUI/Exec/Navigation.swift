import Foundation

/// Recognises a line that does nothing but change directory.
///
/// Such a line must not become a run. Each run is its own `zsh -ic` with a fixed
/// working directory, so `cd frontend` moved a child that then exited: an empty
/// card, and nothing changed. Not a missing feature — a misleading one.
///
/// Deliberately narrow. It covers the forms that resolve without asking anyone:
/// `cd`, `cd -`, `cd <path>`, and a bare path. Everything else — `z`, `pushd`, a
/// shell function, `cd x && make` — stays a normal run, and the directory it ends
/// up in is adopted from its `pwd` afterwards. That fallback is the general
/// mechanism; this is only the shortcut that avoids a pointless card, so it is
/// allowed to not understand something.
///
/// Resolved in Swift and not by asking a shell, because asking costs an
/// interactive shell startup — measured at ~2.6 s in the REPL. Navigation has to
/// feel like moving, not like running something.
enum Navigation {
    enum Outcome: Equatable {
        /// An existing directory, absolute and standardised.
        case move(String)
        /// Resolved, but not a directory that is there.
        case missing(String)
    }

    /// - Parameter previous: what `cd -` goes back to, or nil when nothing yet.
    /// - Returns: nil when the line is a command to run.
    static func outcome(for line: String, in cwd: String, previous: String?) -> Outcome? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        // Anything that chains, pipes or redirects does more than move. `cd x && make`
        // is a real run, and it gets its directory adopted like any other.
        //
        // Globs and history expansion are in the same list, and that is the important
        // half: this resolver treats its argument as a literal name, so `cd src*`
        // found no directory called `src*` and reported one that does not exist —
        // which does not run the line at all. Handing it to the shell instead both
        // expands it and moves the prompt afterwards, through the `pwd` a run
        // reports. Not understanding something has to mean "run it", never "refuse".
        guard trimmed.rangeOfCharacter(from: CharacterSet(charactersIn: "&|;<>()`$*?[]{}!\n")) == nil
        else { return nil }

        let tokens = trimmed.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        if tokens.first == "cd" {
            switch tokens.count {
            case 1:
                return verified(FileManager.default.homeDirectoryForCurrentUser.path)
            case 2 where tokens[1] == "-":
                // No previous directory yet is not an error worth a card either; the
                // prompt says so and stays put.
                guard let previous else { return .missing("-") }
                return verified(previous)
            case 2:
                return verified(absolute(tokens[1], in: cwd))
            default:
                // More operands than a directory change has. Let the shell complain.
                return nil
            }
        }

        // A bare path: `frontend`, `../api`, `~/Downloads`. Only when it really is a
        // directory — a command that happens to share its name with one still runs.
        guard tokens.count == 1 else { return nil }
        let candidate = absolute(trimmed, in: cwd)
        guard isDirectory(candidate) else { return nil }
        return .move(candidate)
    }

    /// Every path leaves here standardised. A trailing slash or an unresolved `..`
    /// would still name the right directory but would not compare equal to it, and
    /// the chip row and the breadcrumb both decide by string comparison against the
    /// current one — so the row would quietly stop highlighting anything.
    private static func verified(_ path: String) -> Outcome {
        let standard = (path as NSString).standardizingPath
        return isDirectory(standard) ? .move(standard) : .missing(standard)
    }

    /// Absolute, with `~` and `..` resolved. `standardizingPath` does both, and also
    /// what `pwd` would report for a path that walks through `/tmp`.
    private static func absolute(_ path: String, in cwd: String) -> String {
        let stripped = path.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        let expanded = (stripped as NSString).expandingTildeInPath
        let joined = expanded.hasPrefix("/") ? expanded : (cwd as NSString).appendingPathComponent(expanded)
        return (joined as NSString).standardizingPath
    }

    private static func isDirectory(_ path: String) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue
    }
}
