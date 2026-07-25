import Foundation

/// Why a command is worth a second look before it runs.
struct Hazard: Equatable {
    /// Phrased as what will happen, not as which rule matched — "discards every
    /// uncommitted change" tells the user something, "matched git-reset-hard" does
    /// not.
    let consequence: String
}

/// Recognises commands whose accidental form is expensive.
///
/// This exists because the overlay changed the stakes. In a terminal a destructive
/// command sits in the scrollback, next to everything else that happened, and it
/// took a deliberate visit to that window to type it. Here it is a hotkey, three
/// characters and Enter, with no history on screen afterwards to work out what
/// happened.
///
/// It is a **heuristic against accidents, not a security boundary**, and it cannot
/// become one. The command runs through `zsh -ic`, so an alias can expand to
/// anything after this has looked at it; a variable, a `bash -c`, or a script hides
/// its contents entirely. Anyone who wants to defeat it can. The point is to catch
/// the shapes people type by mistake.
enum HazardScan {
    static func scan(command: String, cwd: String) -> [Hazard] {
        var found: [Hazard] = []
        var seen = Set<String>()

        func add(_ consequence: String) {
            guard seen.insert(consequence).inserted else { return }
            found.append(Hazard(consequence: consequence))
        }

        // A whole line can hold several commands, and `something && rm -rf x` is
        // exactly the shape that slips past a check that only reads the first word.
        for segment in segments(of: command) {
            let tokens = segment.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard let program = program(of: tokens) else { continue }
            // Everything after the wrappers and the program name itself.
            let start = leadingWrappers(tokens) + 1
            let arguments = start < tokens.count ? Array(tokens[start...]) : []
            let flags = arguments.filter { $0.hasPrefix("-") }
            let operands = arguments.filter { !$0.hasPrefix("-") }

            switch program {
            case "rm":
                // A plain `rm note.txt` is not worth a dialog — there is no trash to
                // fall back on either way, but it names one thing and the user can
                // see which. Recursion, force, wildcards and absolute paths are the
                // shapes that take more than they were meant to.
                let recursive = flags.contains { $0.contains("r") || $0.contains("R") }
                let forced = flags.contains { $0.contains("f") }
                let broad = operands.contains { $0.contains("*") || $0.hasPrefix("/") || $0.contains("..") }
                if recursive || broad {
                    add("deletes whole directory trees, with no undo and no trash")
                } else if forced {
                    add("deletes without asking, with no undo and no trash")
                }

            case "git":
                let joined = arguments.joined(separator: " ")
                if operands.first == "reset", joined.contains("--hard") {
                    add("discards every uncommitted change in the working tree")
                }
                if operands.first == "clean", flags.contains(where: { $0.contains("f") }) {
                    add("deletes untracked files, which were never in a commit to recover from")
                }
                if operands.first == "checkout" || operands.first == "restore" {
                    if operands.contains(".") || joined.contains("--") {
                        add("throws away local edits to the named paths")
                    }
                }
                if operands.first == "push", flags.contains(where: { $0 == "-f" || $0.hasPrefix("--force") }) {
                    add("rewrites history on the remote, for everyone who already pulled it")
                }
                if operands.first == "branch", flags.contains(where: { $0.contains("D") }) {
                    add("deletes a branch even if it was never merged")
                }

            case "dd":
                add("writes over a device or file byte for byte")

            case "diskutil":
                if arguments.contains(where: { $0.lowercased().hasPrefix("erase") || $0 == "reformat" }) {
                    add("erases a disk or volume")
                }

            case "mkfs", "newfs", "newfs_hfs", "newfs_apfs":
                add("creates a new filesystem over whatever is there")

            case "truncate":
                add("cuts files down to a new length, discarding the rest")

            case "shred", "srm":
                add("overwrites files so they cannot be recovered")

            case "docker", "podman":
                let joined = arguments.joined(separator: " ")
                if joined.contains("system prune") || joined.contains("volume rm") || joined.contains("volume prune") {
                    add("removes containers, images or volumes, including their data")
                }

            case "npm", "pnpm", "yarn", "bun":
                if operands.contains("publish") {
                    add("publishes to a registry, which cannot be taken back")
                }

            case "kubectl":
                if operands.first == "delete" {
                    add("deletes cluster resources")
                }

            default:
                break
            }

            // `psql -c 'drop table users'` and friends. Matched on the line rather
            // than parsed, because the SQL sits inside a quoted argument.
            let lowered = segment.lowercased()
            if lowered.contains("drop table") || lowered.contains("drop database") || lowered.contains("truncate table") {
                add("drops or empties database tables")
            }
        }

        if let overwritten = truncatedFile(in: command, cwd: cwd) {
            add("overwrites the existing file \(overwritten)")
        }
        return found
    }

    // MARK: - Parsing
    //
    // Naive on purpose: whitespace splitting, no quote or escape handling. A real
    // shell parser would be the wrong amount of work for a heuristic that already
    // cannot see through aliases.

    private static func segments(of command: String) -> [String] {
        var parts = [command]
        for separator in ["&&", "||", ";", "|", "\n"] {
            parts = parts.flatMap { $0.components(separatedBy: separator) }
        }
        return parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Words that stand in front of the real command without being it.
    private static let wrappers: Set<String> = ["sudo", "command", "env", "nice", "nohup", "time", "doas", "xargs"]

    private static func leadingWrappers(_ tokens: [String]) -> Int {
        var count = 0
        for token in tokens {
            // `env FOO=bar cmd` — an assignment is not the command either.
            if wrappers.contains(token) || token.contains("=") { count += 1 } else { break }
        }
        return count
    }

    private static func program(of tokens: [String]) -> String? {
        let index = leadingWrappers(tokens)
        guard tokens.indices.contains(index) else { return nil }
        // Full paths count: /bin/rm is rm.
        return (tokens[index] as NSString).lastPathComponent
    }

    /// `> file` truncates; `>>` appends and is left alone. Only reported when the
    /// file is actually there — warning about creating a new one would be noise.
    private static func truncatedFile(in command: String, cwd: String) -> String? {
        let characters = Array(command)
        var index = 0
        while index < characters.count {
            guard characters[index] == ">" else {
                index += 1
                continue
            }
            // Skip >>, and the >& / >| forms.
            let next = index + 1 < characters.count ? characters[index + 1] : " "
            if next == ">" || next == "&" || next == "|" {
                index += 2
                continue
            }
            var cursor = index + 1
            while cursor < characters.count, characters[cursor] == " " { cursor += 1 }
            var target = ""
            while cursor < characters.count, !" \t;|&".contains(characters[cursor]) {
                target.append(characters[cursor])
                cursor += 1
            }
            let cleaned = target.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            if !cleaned.isEmpty {
                let path = cleaned.hasPrefix("/") ? cleaned : (cwd as NSString).appendingPathComponent(cleaned)
                var isDirectory: ObjCBool = false
                if FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue {
                    return cleaned
                }
            }
            index = cursor
        }
        return nil
    }
}
