import Foundation

struct Directory: Identifiable, Equatable {
    let path: String
    /// false = guessed from a disk scan because the daemon had nothing learned.
    /// Shown differently on purpose: otherwise the ordering looks arbitrary and
    /// the user cannot tell why.
    let learned: Bool

    var id: String { path }

    /// Last path component, capped. Ambiguous on its own (`a/src` vs `b/src`),
    /// which is why the full path of the selected chip is spelled out underneath
    /// the row.
    ///
    /// The cap is here rather than left to `lineLimit(1)`: a row of chips shares one
    /// width, so letting SwiftUI compress them squeezes EVERY label down to the
    /// longest one's leftovers — three characters, in practice. A bounded label
    /// gives a bounded chip, and the row fits by construction.
    func label(max characters: Int = 12) -> String {
        let name = (path as NSString).lastPathComponent
        let base = name.isEmpty ? path : name
        return base.count <= characters ? base : String(base.prefix(characters - 1)) + "…"
    }
}

/// Shortens a path for somewhere with no room for it.
///
/// The chips get away with the last component alone because the selected one is spelled
/// out in full underneath the row. A badge in the rail has no such neighbour: `frontend`
/// there does not say which project, and this machine has several.
///
/// So: as much of the END as fits. The last component names the directory, the ones
/// before it are the context that tells them apart, and the front of the path is the
/// part every path on the machine has in common.
enum PathLabel {
    /// Cached, because it cannot change while the process runs and the directory filter
    /// would otherwise ask for it once per row per render.
    static let home = FileManager.default.homeDirectoryForCurrentUser.path

    /// `~` for home, `~/projects/tabby` while the whole thing fits, and
    /// `…/prestonpalace-nl/frontend` once it does not.
    ///
    /// A budget in characters and not in points: the label is drawn in a monospaced
    /// font, where the two are the same thing, and a view that measured text would have
    /// to measure it again on every frame.
    static func trail(
        of path: String,
        home: String = PathLabel.home,
        budget: Int = 40
    ) -> String {
        let cleaned = withoutTrailingSlash(path)
        guard !cleaned.isEmpty else { return "" }
        guard cleaned != "/" else { return "/" }
        let root = withoutTrailingSlash(home)
        if !root.isEmpty, cleaned == root { return "~" }

        let insideHome = !root.isEmpty && cleaned.hasPrefix(root + "/")
        let relative = insideHome ? String(cleaned.dropFirst(root.count + 1)) : cleaned
        let components = relative.split(separator: "/").map(String.init)
        guard !components.isEmpty else { return cleaned }

        var kept: [String] = []
        for component in components.reversed() {
            let assembled = ([component] + kept).count - 1 + component.count
                + kept.reduce(0) { $0 + $1.count }
            // The prefix costs characters too, so it counts against the budget: giving
            // up a component to make room for the `…/` that says a component was given
            // up would be a trade for nothing.
            let complete = kept.count + 1 == components.count
            let prefix = complete ? (insideHome ? 2 : (cleaned.hasPrefix("/") ? 1 : 0)) : 2
            // At least one component always, whatever it costs. A name too long for the
            // badge is still the only thing that identifies the directory; the view
            // truncates it at the front, where a path carries the least.
            if !kept.isEmpty, assembled + prefix > budget { break }
            kept.insert(component, at: 0)
        }

        let complete = kept.count == components.count
        let prefix = complete ? (insideHome ? "~/" : (cleaned.hasPrefix("/") ? "/" : "")) : "…/"
        return prefix + kept.joined(separator: "/")
    }

    /// The whole path, home as `~`.
    ///
    /// What a row in the list shows, and what the directory filter matches against —
    /// the same string for both, so that typing `~/pro` finds what the eye can read on
    /// screen. A row has the launcher's width, so unlike the badge nothing has to be
    /// given up here.
    static func full(of path: String, home: String = PathLabel.home) -> String {
        let cleaned = withoutTrailingSlash(path)
        let root = withoutTrailingSlash(home)
        guard !root.isEmpty, cleaned != "/" else { return cleaned }
        if cleaned == root { return "~" }
        guard cleaned.hasPrefix(root + "/") else { return cleaned }
        return "~/" + cleaned.dropFirst(root.count + 1)
    }

    private static func withoutTrailingSlash(_ path: String) -> String {
        var value = path.trimmingCharacters(in: .whitespaces)
        while value.count > 1, value.hasSuffix("/") { value.removeLast() }
        return value
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
