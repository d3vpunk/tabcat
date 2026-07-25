import AppKit
import SwiftUI

/// Skeleton of the third tabcat front end: a global hotkey, an overlay that takes
/// keys without stealing the active app, and a prompt with ghost text from the
/// same daemon the zsh plugin talks to.
///
/// Not here yet, on purpose: no PTY (Enter shows what WOULD run), no directory
/// chips (the top `cwds` entry is used silently), no `learn` after a run.
@MainActor
final class Controller {
    private let panel: OverlayPanel
    private let model = PromptModel()
    private let hotKey = HotKey()

    init() {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        // Sized to the content, not to the screen: a screen-sized transparent
        // panel swallows every click in its frame, drawn or not.
        let frame = NSRect(x: screen.midX - 400, y: screen.midY - 130, width: 800, height: 260)

        panel = OverlayPanel(contentRect: frame)
        panel.contentView = NSHostingView(rootView: PromptView(model: model))
        model.connect()
    }

    func start() {
        let registered = hotKey.register { [weak self] in self?.toggle() }
        if !registered {
            // A dead shortcut with no explanation is worse than a visible failure.
            FileHandle.standardError.write(Data("tabcat-gui: could not register ⌥Space\n".utf8))
        }
        show()
    }

    private func toggle() {
        panel.isVisible ? panel.orderOut(nil) : show()
    }

    private func show() {
        // makeKeyAndOrderFront on a nonactivating panel takes the keyboard without
        // making this the active application.
        panel.makeKeyAndOrderFront(nil)
    }
}

// stdout is read while this runs, and a pipe would hold every line until exit.
setvbuf(stdout, nil, _IONBF, 0)

// A headless preflight, before any window exists: an LSUIElement app has nowhere
// to report a broken socket path or a protocol mismatch.
if CommandLine.arguments.contains("--check") {
    exit(await Check.run())
}

let app = NSApplication.shared
// No Dock icon, no menu bar, no app switch when the overlay appears. Info.plist
// carries LSUIElement for the bundled build; this covers a bare `swift run`.
app.setActivationPolicy(.accessory)

let delegate = AppDelegate()
app.delegate = delegate
app.run()

/// The controller is built here rather than at top level: top-level code is not
/// main-actor isolated, and everything it touches is.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: Controller?

    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            let controller = Controller()
            self.controller = controller
            controller.start()
        }
    }
}
