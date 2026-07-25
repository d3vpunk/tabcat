import AppKit
import Carbon.HIToolbox

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
    func register(keyCode: UInt32 = UInt32(kVK_Space), modifiers: UInt32 = UInt32(optionKey), action: @escaping () -> Void) -> Bool {
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
            keyCode, modifiers, id, GetApplicationEventTarget(), 0, &reference
        )
        return status == noErr
    }

    deinit {
        if let reference { UnregisterEventHotKey(reference) }
    }
}
