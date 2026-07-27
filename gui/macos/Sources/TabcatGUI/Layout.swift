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
    static let preferredLauncherSize = CGSize(width: 1200, height: 440)
    static let preferredCardHeight: CGFloat = 400
    /// The smallest card worth drawing, and the room the launcher gives up for it.
    ///
    /// Reserved rather than hoped for: the launcher used to take its full height and
    /// the card was pushed back up off the bottom edge into the prompt, which on a
    /// laptop meant the run card overlapped the candidate list. Whoever is short of
    /// room now loses height, not position.
    static let minimumCardHeight: CGFloat = 140
    /// Below this the launcher stops giving room away — a prompt squeezed to nothing
    /// helps nobody. Reached only on a screen shorter than about 375 pt of usable
    /// height, which is smaller than the overlay is meant for; there the two boxes
    /// overlap again, and honestly so.
    static let minimumLauncherHeight: CGFloat = 240
    static let badgeSize = CGSize(width: 300, height: 56)
    static let badgeGap: CGFloat = 10
    /// The rail is sized for at least this many badges whether they are there or
    /// not, so badges appearing and disappearing within that range never needs a
    /// reframe. A floor and not a cap: a run is never dropped to keep the rail short.
    static let railCapacity = 4
    private static let cardGap: CGFloat = 14

    let screen: NSRect
    /// What the launcher asks for horizontally — `gui.launcherWidth`, clamped to
    /// the screen below. A parameter and not the constant, so the setting reaches
    /// the layout without the layout reading files.
    let preferredWidth: CGFloat

    init(
        screen: NSRect = NSRect(x: 0, y: 0, width: 1440, height: 900),
        preferredWidth: CGFloat = Layout.preferredLauncherSize.width
    ) {
        self.screen = screen
        self.preferredWidth = preferredWidth
    }

    /// The screen the pointer is on — where the user is looking, and the only choice
    /// that survives a display being unplugged. Falls back to the main screen, and
    /// then to any screen at all, because `NSScreen.main` is nil while no window is
    /// key.
    static func onPointerScreen(preferredWidth: CGFloat = Layout.preferredLauncherSize.width) -> Layout {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen else { return Layout(preferredWidth: preferredWidth) }
        return Layout(screen: screen.visibleFrame, preferredWidth: preferredWidth)
    }

    // MARK: - Sizes, fitted to this screen

    /// The vertical room the overlay may use at all.
    private var usable: CGFloat { screen.height - 2 * Self.margin }

    var launcherSize: CGSize {
        // Height is capped twice: by what looks right, and by what still leaves the
        // smallest useful card underneath. The second cap is the one that makes a short
        // screen work — the box gives up height so the card keeps its place.
        let sharing = max(Self.minimumLauncherHeight, usable - Self.cardGap - Self.minimumCardHeight)
        return CGSize(
            width: min(preferredWidth, screen.width - 2 * Self.margin),
            height: min(Self.preferredLauncherSize.height, usable, sharing)
        )
    }

    /// The height the card is planned with: the rest of the usable height, between the
    /// smallest one worth drawing and the one that looks right.
    ///
    /// Only a plan — `card(below:)` works from the launcher's *measured* glass, which is
    /// usually shorter than its box and therefore leaves more room than this. It exists
    /// so the launcher can be placed knowing how much has to fit below it.
    private var plannedCardHeight: CGFloat {
        max(Self.minimumCardHeight, min(Self.preferredCardHeight, usable - launcherSize.height - Self.cardGap))
    }

    // MARK: - Positions

    /// Chips and prompt, centred, its TOP edge a quarter of the way down the screen.
    ///
    /// Anchored by the top and not by the bottom: the content hangs from the top
    /// edge, so that is the edge that has to stay put when the box grows to hold a
    /// longer candidate list.
    ///
    /// A quarter down rather than a fixed distance above the middle, because the middle
    /// is the wrong reference — what has to fit is everything BELOW the prompt, and that
    /// is measured from the top. The old rule put the launcher's bottom 170 pt above
    /// centre on every screen alike, which on a laptop left less room underneath than a
    /// card needs. Pushed higher still when even a quarter down does not leave room, so
    /// the stack ends at the bottom margin instead of running past it.
    var launcher: NSRect {
        let size = launcherSize
        let stack = size.height + Self.cardGap + plannedCardHeight
        let aQuarterDown = screen.minY + screen.height * 3 / 4
        let top = min(screen.maxY - Self.margin, max(aQuarterDown, screen.minY + Self.margin + stack))
        return NSRect(
            x: screen.midX - size.width / 2,
            y: top - size.height,
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
    /// Shrinks to what is left rather than being pushed up: a shorter card is still a
    /// readable card, while one shoved into the candidate list hides the list and reads
    /// as a rendering bug. `launcherSize` reserves `minimumCardHeight` for exactly this,
    /// so what is left only falls below that height when the glass grew past its own box
    /// — a confirmation card on a short screen, and transient.
    ///
    /// The measured height is NOT clamped to the box. Clamping meant a glass taller than
    /// its box stopped pushing the card down and started overlapping it instead.
    func card(below launcherHeight: CGFloat) -> NSRect {
        let size = launcherSize
        let bottom = screen.minY + Self.margin
        let top = launcher.maxY - launcherHeight - Self.cardGap
        let height = max(0, min(Self.preferredCardHeight, top - bottom))
        return NSRect(
            x: screen.midX - size.width / 2,
            y: top - height,
            width: size.width,
            height: height
        )
    }

    /// Every position the card can end up in, whatever the glass measured.
    ///
    /// The panel's frame comes from this rather than from one card rect: the card moves
    /// with a glass whose height is only known after SwiftUI has laid it out, and a frame
    /// computed for one height clipped the card at another.
    private var cardArea: NSRect {
        let size = launcherSize
        let bottom = screen.minY + Self.margin
        return NSRect(
            x: screen.midX - size.width / 2,
            y: bottom,
            width: size.width,
            height: max(0, launcher.minY - bottom)
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
    /// The launcher's box plus the whole area a card can occupy, so the frame never has
    /// to change just because the glass grew a confirmation card and moved the card down.
    func panelOpen(badges: Int) -> NSRect {
        launcher.insetBy(dx: -12, dy: -12)
            .union(cardArea.insetBy(dx: -12, dy: -12))
            .union(rail(badges: badges))
    }

    /// Launcher closed: only the rail, so the rest of the screen takes clicks again.
    func panelClosed(badges: Int) -> NSRect { rail(badges: badges) }
}
