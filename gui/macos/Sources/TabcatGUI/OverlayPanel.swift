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
}
