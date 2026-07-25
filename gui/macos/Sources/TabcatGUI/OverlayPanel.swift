import AppKit

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
    override func cancelOperation(_ sender: Any?) {
        orderOut(nil)
    }
}
