import AppKit

/// Where everything sits, in AppKit screen coordinates.
///
/// Screen coordinates and not SwiftUI's own space, because of what Spike 1 found:
/// a panel swallows every click inside its frame, so the frame has to shrink to the
/// rail once only badges are left. Positions therefore cannot be expressed relative
/// to the panel — the panel is the thing that moves. The view converts through
/// whatever frame is current, and changing frame and conversion in the same turn
/// leaves the content visually still.
struct Layout {
    static let margin: CGFloat = 24
    /// Fixed, and generous enough for chips, prompt and a confirmation card. Fixed
    /// because the card below is positioned relative to it: a box that grew with its
    /// content would push the card off its own slot.
    static let launcherSize = CGSize(width: 800, height: 300)
    /// Same width as the launcher, derived rather than repeated: the two are stacked
    /// and any difference reads as a misalignment.
    static let cardSize = CGSize(width: launcherSize.width, height: 260)
    static let badgeSize = CGSize(width: 300, height: 56)
    static let badgeGap: CGFloat = 10
    /// The rail is sized for this many badges whether they are there or not, so
    /// badges appearing and disappearing never needs a reframe.
    static let railCapacity = 4

    let screen: NSRect

    init(screen: NSRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)) {
        self.screen = screen
    }

    /// Chips and prompt, centred and slightly above middle so the foreground card
    /// has room underneath it.
    var launcher: NSRect {
        NSRect(
            x: screen.midX - Self.launcherSize.width / 2,
            y: screen.midY - 130,
            width: Self.launcherSize.width,
            height: Self.launcherSize.height
        )
    }

    /// The run in front, directly below the launcher's visible glass.
    ///
    /// Takes the measured height because the launcher's box is fixed but its glass
    /// hugs its content and sits at the box's top edge — going by the box would leave
    /// the difference as a gap.
    func card(below launcherHeight: CGFloat) -> NSRect {
        let top = launcher.maxY - min(launcherHeight, Self.launcherSize.height) - 14
        return NSRect(
            x: screen.midX - Self.cardSize.width / 2,
            y: top - Self.cardSize.height,
            width: Self.cardSize.width,
            height: Self.cardSize.height
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

    var rail: NSRect {
        let height = CGFloat(Self.railCapacity) * (Self.badgeSize.height + Self.badgeGap)
        return NSRect(
            x: screen.maxX - Self.margin - Self.badgeSize.width,
            y: screen.minY,
            width: Self.badgeSize.width + Self.margin,
            height: height + Self.margin
        )
        // Glass bleeds past its own bounds, so both boxes below are grown a little.
        .insetBy(dx: -8, dy: -8)
    }

    /// While the launcher is open: everything, so a card can animate from the middle
    /// to the corner without the frame changing under it mid-flight.
    ///
    /// Computed for a FULL launcher, which puts the card at its lowest. A shorter
    /// launcher moves the card up, so this stays a superset and the frame never has
    /// to change just because the launcher grew a confirmation card.
    var panelOpen: NSRect {
        launcher.insetBy(dx: -12, dy: -12)
            .union(card(below: Self.launcherSize.height).insetBy(dx: -12, dy: -12))
            .union(rail)
    }

    /// Launcher closed: only the rail, so the rest of the screen takes clicks again.
    var panelClosed: NSRect { rail }
}
