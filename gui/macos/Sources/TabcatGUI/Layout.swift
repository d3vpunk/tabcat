import AppKit

/// Where everything sits, in AppKit screen coordinates.
///
/// Screen coordinates and not SwiftUI's own space, because of what Spike 1 found:
/// a panel swallows every click inside its frame, so the frame has to shrink to the
/// rail once only badges are left. Positions therefore cannot be expressed relative
/// to the panel — the panel is the thing that moves. The view converts through
/// whatever frame is current, and changing frame and conversion in the same turn
/// leaves the content visually still.
///
/// A value, recomputed, never cached. Held once at launch it described a display
/// that unplugging an HDMI cable had removed, and the overlay went on opening at
/// coordinates belonging to a screen that was no longer there.
struct Layout: Equatable {
    static let margin: CGFloat = 24
    /// What the launcher asks for. What it gets is `launcherSize`, fitted to the
    /// screen it is actually on — a box wider than the display is not a layout, it is
    /// a bug you only meet on the laptop.
    static let preferredLauncherSize = CGSize(width: 800, height: 440)
    static let preferredCardHeight: CGFloat = 260
    static let badgeSize = CGSize(width: 300, height: 56)
    static let badgeGap: CGFloat = 10
    /// The rail is sized for at least this many badges whether they are there or
    /// not, so badges appearing and disappearing within that range never needs a
    /// reframe. A floor and not a cap: a run is never dropped to keep the rail short.
    static let railCapacity = 4
    /// How far the launcher's top edge sits above the middle, when there is room.
    private static let launcherRise: CGFloat = 170
    private static let cardGap: CGFloat = 14

    let screen: NSRect

    init(screen: NSRect = NSRect(x: 0, y: 0, width: 1440, height: 900)) {
        self.screen = screen
    }

    /// The screen the pointer is on — where the user is looking, and the only choice
    /// that survives a display being unplugged. Falls back to the main screen, and
    /// then to any screen at all, because `NSScreen.main` is nil while no window is
    /// key.
    static func onPointerScreen() -> Layout {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen else { return Layout() }
        return Layout(screen: screen.visibleFrame)
    }

    // MARK: - Sizes, fitted to this screen

    var launcherSize: CGSize {
        CGSize(
            width: min(Self.preferredLauncherSize.width, screen.width - 2 * Self.margin),
            height: min(Self.preferredLauncherSize.height, screen.height - 2 * Self.margin)
        )
    }

    // MARK: - Positions

    /// Chips and prompt, centred, its TOP edge above the middle so the foreground
    /// card has room underneath.
    ///
    /// Anchored by the top and not by the bottom: the content hangs from the top
    /// edge, so that is the edge that has to stay put when the box grows to hold a
    /// longer candidate list. Kept inside the visible area, which after an external
    /// display goes away is a good deal smaller.
    var launcher: NSRect {
        let size = launcherSize
        let top = min(screen.midY + Self.launcherRise, screen.maxY - Self.margin)
        return NSRect(
            x: screen.midX - size.width / 2,
            y: max(screen.minY + Self.margin, top - size.height),
            width: size.width,
            height: size.height
        )
    }

    /// The run in front, directly below the launcher's visible glass.
    ///
    /// Takes the measured height because the launcher's box is fixed but its glass
    /// hugs its content and sits at the box's top edge — going by the box would leave
    /// the difference as a gap.
    ///
    /// Pushed back up rather than allowed off the bottom edge. On a screen too short
    /// for both it ends up overlapping the launcher, which is worth having: a card
    /// that overlaps can still be read, and one that hangs off the bottom cannot.
    func card(below launcherHeight: CGFloat) -> NSRect {
        let size = launcherSize
        let top = launcher.maxY - min(launcherHeight, size.height) - Self.cardGap
        let height = min(Self.preferredCardHeight, screen.height - 2 * Self.margin)
        return NSRect(
            x: screen.midX - size.width / 2,
            y: max(screen.minY + Self.margin, top - height),
            width: size.width,
            height: height
        )
    }

    /// Bottom-right, growing upwards, so the newest badge is nearest the corner.
    func badge(_ index: Int) -> NSRect {
        NSRect(
            x: screen.maxX - Self.margin - Self.badgeSize.width,
            y: screen.minY + Self.margin + CGFloat(index) * (Self.badgeSize.height + Self.badgeGap),
            width: Self.badgeSize.width,
            height: Self.badgeSize.height
        )
    }

    /// Sized for whichever is larger: the reserved capacity, or the badges actually
    /// there. Growing past the capacity is what lets a run outlive the rail being
    /// full — the alternative was killing the oldest one to make room.
    func rail(badges: Int) -> NSRect {
        let rows = max(Self.railCapacity, badges)
        let height = CGFloat(rows) * (Self.badgeSize.height + Self.badgeGap)
        return NSRect(
            x: screen.maxX - Self.margin - Self.badgeSize.width,
            y: screen.minY,
            width: Self.badgeSize.width + Self.margin,
            height: height + Self.margin
        )
        // Glass bleeds past its own bounds, so both boxes below are grown a little.
        .insetBy(dx: -8, dy: -8)
        .intersection(screen.insetBy(dx: -8, dy: -8))
    }

    /// While the launcher is open: everything, so a card can animate from the middle
    /// to the corner without the frame changing under it mid-flight.
    ///
    /// Computed for a FULL launcher, which puts the card at its lowest. A shorter
    /// launcher moves the card up, so this stays a superset and the frame never has
    /// to change just because the launcher grew a confirmation card.
    func panelOpen(badges: Int) -> NSRect {
        launcher.insetBy(dx: -12, dy: -12)
            .union(card(below: launcherSize.height).insetBy(dx: -12, dy: -12))
            .union(rail(badges: badges))
    }

    /// Launcher closed: only the rail, so the rest of the screen takes clicks again.
    func panelClosed(badges: Int) -> NSRect { rail(badges: badges) }
}
