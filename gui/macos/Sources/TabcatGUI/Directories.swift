import Foundation

struct Directory: Identifiable, Equatable {
    let path: String
    /// false = guessed from a disk scan because the daemon had nothing learned.
    /// Shown differently on purpose: otherwise the ordering looks arbitrary and
    /// the user cannot tell why.
    let learned: Bool

    var id: String { path }

    /// Last path component — short enough for a chip. Ambiguous on its own
    /// (`a/src` vs `b/src`), which is why the full path of the selected chip is
    /// spelled out underneath the row.
    var label: String {
        let name = (path as NSString).lastPathComponent
        return name.isEmpty ? path : name
    }
}

enum DirectorySeed {
    /// Cold start: the daemon can only rank directories it has seen, and every
    /// imported shell history entry carries no directory at all. So on a fresh
    /// install `cwds` is legitimately empty and something has to fill the row.
    ///
    /// A bounded walk, not Spotlight. `mdfind "kMDItemFSName == '.git'"` returns
    /// nothing at all — Spotlight does not index hidden entries, so the one marker
    /// that identifies a repository is invisible to it. Measured on this machine:
    /// the walk below takes ~0.15 s, an unpruned one ~1.7 s and it drags in caches
    /// from dot-directories.
    ///
    /// Depth 4 from home covers `~/projects/<name>` and one level under it. Pruning
    /// Library, node_modules and every dot-directory except `.git` itself is what
    /// makes it both fast and free of `~/.gitkraken/tutorial`-style noise.
    static func gitRepositories(limit: Int) async -> [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let output = await run("/usr/bin/find", [
            home, "-maxdepth", "4",
            "(", "-type", "d",
            "(", "-name", "Library", "-o", "-name", "node_modules", "-o",
            "(", "-name", ".*", "!", "-name", ".git", ")", ")",
            "-prune", ")",
            "-o", "(", "-name", ".git", "-type", "d", "-print", ")",
        ])

        let repositories = output
            .split(separator: "\n")
            .map { (String($0) as NSString).deletingLastPathComponent }
            .filter { !$0.isEmpty }

        // Most recently touched first: a decent stand-in for "what are you working
        // on" until real usage takes over.
        let dated = repositories.compactMap { path -> (String, Date)? in
            guard let modified = try? FileManager.default
                .attributesOfItem(atPath: path)[.modificationDate] as? Date else { return nil }
            return (path, modified)
        }
        var seen = Set<String>()
        return dated
            .sorted { $0.1 > $1.1 }
            .map(\.0)
            .filter { seen.insert($0).inserted }
            .prefix(limit)
            .map { $0 }
    }

    private static func run(_ executable: String, _ arguments: [String]) async -> String {
        await withCheckedContinuation { continuation in
            // Off the main thread: a cold Spotlight query still takes long enough
            // to be felt if the overlay waited for it.
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = FileHandle.nullDevice
                guard (try? process.run()) != nil else {
                    continuation.resume(returning: "")
                    return
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                continuation.resume(returning: String(decoding: data, as: UTF8.self))
            }
        }
    }
}
