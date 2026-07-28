import AppKit
import Carbon.HIToolbox

/// The combination that summons the overlay.
///
/// Configurable rather than compiled in, because which combination is free is a
/// property of someone's machine and not of this program: ⌥Space is what Alfred and
/// Raycast take by default, and a launcher whose trigger is already owned is a
/// launcher that opens two windows.
///
///     defaults write nl.d3vpunk.tabcat.gui hotkey "ctrl cmd s"   # the bundled app
///     TABCAT_HOTKEY="ctrl cmd s" swift run TabcatGUI             # a development run
///
/// Both, because neither reaches the other: an app started from the Finder inherits
/// no environment, and a bare `swift run` has a different defaults domain than the
/// bundle. The variable is the same shape the rest of tabcat is configured with.
///
/// Words in any order, one non-modifier key: `cmd`, `ctrl`, `opt`/`alt`, `shift`,
/// plus `space`, `escape`, `return`, `tab`, a letter or a digit.
struct HotKeyCombo {
    let keyCode: UInt32
    let carbonModifiers: UInt32
    /// The same modifiers as AppKit sees them, for the hold-to-cycle check.
    let held: NSEvent.ModifierFlags
    let description: String

    /// ⌥Space, which is what the documentation describes and what most machines
    /// have free.
    static let fallback = HotKeyCombo(
        keyCode: UInt32(kVK_Space),
        carbonModifiers: UInt32(optionKey),
        held: .option,
        description: "⌥Space"
    )

    static func configured(
        _ defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileHotkey: String? = BootSettings.load().hotkey
    ) -> HotKeyCombo {
        // Environment first: it is the one a development run can set, and setting it
        // deliberately should beat whatever is stored. Then `gui.hotkey` from
        // settings.json — where the gear panel writes — and only then the legacy
        // `defaults write … hotkey`, kept so an existing setup does not lose its
        // combination on update.
        for raw in [environment["TABCAT_HOTKEY"], fileHotkey, defaults.string(forKey: "hotkey")] {
            if let raw, let parsed = HotKeyCombo(raw) { return parsed }
        }
        return .fallback
    }

    init(keyCode: UInt32, carbonModifiers: UInt32, held: NSEvent.ModifierFlags, description: String) {
        self.keyCode = keyCode
        self.carbonModifiers = carbonModifiers
        self.held = held
        self.description = description
    }

    init?(_ text: String) {
        var carbon: UInt32 = 0
        var held: NSEvent.ModifierFlags = []
        var symbols = ""
        var key: (code: UInt32, label: String)?

        for word in text.lowercased().split(whereSeparator: { " +-".contains($0) }) {
            switch word {
            case "cmd", "command": carbon |= UInt32(cmdKey); held.insert(.command); symbols += "⌘"
            case "ctrl", "control": carbon |= UInt32(controlKey); held.insert(.control); symbols += "⌃"
            case "opt", "alt", "option": carbon |= UInt32(optionKey); held.insert(.option); symbols += "⌥"
            case "shift": carbon |= UInt32(shiftKey); held.insert(.shift); symbols += "⇧"
            default:
                // One non-modifier key, and only one: a second would silently win over
                // the first and bind something nobody asked for.
                guard key == nil, let code = Self.keyCode(for: String(word)) else { return nil }
                key = (code, String(word).capitalized)
            }
        }

        // A bare key with no modifier would fire while typing in any application.
        guard let key, !held.isEmpty else { return nil }
        self.init(keyCode: key.code, carbonModifiers: carbon, held: held, description: symbols + key.label)
    }

    /// Virtual key codes are positions, not characters, and this table is the ANSI
    /// layout. Every letter sits in the same place on QWERTZ except `y` and `z`,
    /// which are swapped — worth knowing before binding one of those two.
    private static func keyCode(for name: String) -> UInt32? {
        let named: [String: Int] = [
            "space": kVK_Space, "escape": kVK_Escape, "esc": kVK_Escape,
            "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab,
        ]
        if let code = named[name] { return UInt32(code) }

        let letters = "asdfhgzxcv#bqweryt123465=97-80]ou[ip#lj'k;\\,/nm."
        guard name.count == 1, let index = Array(letters).firstIndex(of: Character(name)) else { return nil }
        return UInt32(index)
    }
}

/// A single global hotkey via Carbon.
///
/// Carbon and not CGEventTap or NSEvent's global monitor: those two are TCC-gated,
/// so they cost an Accessibility permission dialog — and because a locally built
/// binary's signature changes with every rebuild, that permission would have to be
/// granted again and again. RegisterEventHotKey needs no permission at all.
///
/// Note from the Carbon header: the same combination may be registered by several
/// applications, and all of them get notified. A clash with another launcher does
/// not fail here, it just means both react.
@MainActor
final class HotKey {
    private var reference: EventHotKeyRef?
    private static var action: (() -> Void)?

    /// - Returns: false when the handler or the registration was refused, so the
    ///   caller can say so instead of leaving the user with a dead shortcut.
    @discardableResult
    func register(_ combo: HotKeyCombo, action: @escaping () -> Void) -> Bool {
        HotKey.action = action

        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        // The C callback cannot capture context, hence the static closure.
        let installed = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, _ -> OSStatus in
                MainActor.assumeIsolated { HotKey.action?() }
                return noErr
            },
            1, &spec, nil, nil
        )
        guard installed == noErr else { return false }

        // 'TBCT', so the id is recognisably ours in a debugger.
        let id = EventHotKeyID(signature: OSType(0x5442_4354), id: 1)
        let status = RegisterEventHotKey(
            combo.keyCode, combo.carbonModifiers, id, GetApplicationEventTarget(), 0, &reference
        )
        return status == noErr
    }

    deinit {
        if let reference { UnregisterEventHotKey(reference) }
    }
}
