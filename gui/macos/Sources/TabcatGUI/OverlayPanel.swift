import AppKit
import SwiftUI

/// Hosts the overlay's content and takes the click that made the window key, rather
/// than spending it.
///
/// The rail is deliberately shown without the keyboard, so every click on a badge
/// lands on a window that is not key — and by default the first click there only
/// promotes the window and is never delivered. A badge would need two clicks, and
/// the first would quietly have made the panel key behind the model's back.
///
/// On the view and not on the window: `acceptsFirstMouse(for:)` is `NSView`'s.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The overlay window.
///
/// Two things here are load-bearing and were both established by spike:
///
/// `canBecomeKey` — borderless windows return false, which would leave the
/// overlay unable to receive a single keystroke. Overriding it is the only reason
/// this is a subclass rather than a configured NSPanel.
///
/// `.nonactivatingPanel` — without it, showing the overlay switches the active
/// application, and the window the user was working in loses focus. With it, that
/// app stays frontmost while the overlay still takes keys.
final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    /// Never the main window: that is the app the user was actually working in.
    override var canBecomeMain: Bool { false }

    /// Escape, when nothing in the content claimed it.
    var onCancel: (() -> Void)?

    /// The panel stopped being the key window while it was still on screen.
    var onFocusLost: (() -> Void)?

    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        // The glass draws its own shadow; a window shadow would double it.
        hasShadow = false
        level = .floating
        // Follow the user across spaces and sit above full-screen apps, which is
        // where "no terminal open" most often happens.
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isMovable = false
        // A closed overlay must not keep the process from exiting cleanly.
        isReleasedWhenClosed = false
    }

    /// A borderless panel gets no free Escape handling, and the frame is not
    /// draggable, so cancelOperation is the one place to hide from.
    ///
    /// It hands the decision up rather than ordering itself out. Hiding itself left
    /// the controller's `launcherVisible` still saying the launcher was on screen,
    /// and since the frame is reapplied on every model change, the next one — a run
    /// finishing, a status line, an auto-dismiss — pulled the overlay back up on its
    /// own.
    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    /// The keyboard went somewhere else — another application, Spotlight, a dialog.
    ///
    /// The overlay holds the keyboard without being the active application, so nothing
    /// else takes it away by accident: as long as it is up it has focus, and losing
    /// focus therefore means it should not be up. Measured rather than assumed —
    /// activating another application does resign key on a `.nonactivatingPanel`, while
    /// leaving it visible, so the flag and the window would otherwise drift apart.
    ///
    /// Handed up for the same reason as `cancelOperation`.
    override func resignKey() {
        super.resignKey()
        onFocusLost?()
    }

    /// The prompt keeps the keyboard for as long as it is on screen.
    ///
    /// A click on a run card makes SwiftTerm's view first responder, and that view
    /// forwards keystrokes into the pty — which is a feature that does not exist yet
    /// (`PLAN-gui-rehaul.md`, phase 4) and today only means the next thing typed
    /// disappears into a running command instead of appearing at the prompt. The click
    /// is delivered first and the prompt takes the keyboard back afterwards, so
    /// bringing a card to the front still works.
    ///
    /// Keyed on the field existing rather than on a flag: `PromptView` is only in the
    /// hierarchy while the launcher is up, so with the rail alone there is nothing to
    /// restore and nothing to guard against.
    override func sendEvent(_ event: NSEvent) {
        super.sendEvent(event)
        // Left button only. A right click can open a context menu, which runs its own
        // event loop, and taking the keyboard back from underneath it is not this
        // method's business.
        guard event.type == .leftMouseUp else { return }
        guard let field = contentView?.firstDescendant(of: GhostTextView.self) else { return }
        if firstResponder !== field { makeFirstResponder(field) }
    }
}

extension NSView {
    /// First view of this kind anywhere below, breadth first.
    func firstDescendant<V: NSView>(of kind: V.Type) -> V? {
        var queue = subviews
        while !queue.isEmpty {
            let view = queue.removeFirst()
            if let match = view as? V { return match }
            queue.append(contentsOf: view.subviews)
        }
        return nil
    }
}
