import Foundation

/// The two settings the overlay needs BEFORE it can reach the daemon: the
/// launcher's width (the layout exists before any connection) and the hotkey
/// (registered at startup). Everything else arrives over the wire, schema and
/// all — these two are read straight from settings.json, and their defaults are
/// duplicated here on purpose. `gui/boot-defaults.json` is the fixture that
/// pins this copy to `src/settings/schema.ts`: a vitest test checks the fixture
/// against the schema, the `bootDefaults` table in Check checks it against this
/// struct. Drift on either side goes red instead of shipping two defaults.
struct BootSettings: Equatable {
    static let defaultLauncherWidth = 1200
    static let defaultHotkey = "opt space"
    /// Mirrors the schema's min/max; an out-of-range width falls back to the
    /// default exactly like the TypeScript reader does.
    static let widthRange = 700...2400

    var launcherWidth = CGFloat(BootSettings.defaultLauncherWidth)
    /// nil = not set in the file. Optional on purpose: the hotkey chain has a
    /// legacy UserDefaults rung behind this one, and a default surfacing here
    /// would shadow it forever.
    var hotkey: String?

    static func settingsFile() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".config/tabcat/settings.json")
    }

    /// Mirrors `readSettings` in src/settings/store.ts: the file is sparse,
    /// keys may be nested or flat-dotted, an invalid value falls back to the
    /// default, a broken file is all defaults. Never throws — a hand-edited
    /// typo must not take the overlay down.
    static func load(from url: URL = settingsFile()) -> BootSettings {
        guard let data = try? Data(contentsOf: url),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return BootSettings()
        }
        var settings = BootSettings()
        if let width = intValue(root, key: "gui.launcherWidth"), widthRange.contains(width) {
            settings.launcherWidth = CGFloat(width)
        }
        if let hotkey = value(root, key: "gui.hotkey") as? String {
            settings.hotkey = hotkey
        }
        return settings
    }

    /// Nested (`{"gui": {"hotkey": …}}`) or flat (`{"gui.hotkey": …}`) — the
    /// TypeScript reader accepts both spellings, so this one has to.
    private static func value(_ root: [String: Any], key: String) -> Any? {
        if let flat = root[key] { return flat }
        var node: Any? = root
        for part in key.split(separator: ".") {
            node = (node as? [String: Any])?[String(part)]
        }
        return node
    }

    private static func intValue(_ root: [String: Any], key: String) -> Int? {
        guard let number = value(root, key: key) as? NSNumber,
              // A JSON bool bridges to NSNumber too — `true` must not read as
              // width 1.
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == number.doubleValue.rounded()
        else { return nil }
        return number.intValue
    }
}
