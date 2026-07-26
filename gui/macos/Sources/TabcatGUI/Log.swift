import os

/// Where a bundled overlay says something went wrong.
///
/// An `LSUIElement` app launched with `open` has no terminal attached, so anything
/// written to stderr goes nowhere anybody looks. Unified logging is the one channel
/// that survives that, and it is what `bundle.sh` prints the `log stream` command for —
/// a hint that used to point at a subsystem nothing in this app ever wrote to.
///
/// Deliberately thin. Failures the user can act on belong on screen, in `status`; this
/// is for the ones that have no screen to appear on because the overlay never came up.
enum Log {
    /// The subsystem is the bundle identifier from `Info.plist`, so the predicate in
    /// `bundle.sh` and this constant have to stay the same string.
    static let app = Logger(subsystem: "nl.d3vpunk.tabcat.gui", category: "app")
}
