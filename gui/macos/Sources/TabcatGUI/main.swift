import AppKit
import Carbon.HIToolbox
import SwiftUI

/// Skeleton of the third tabcat front end: a global hotkey, an overlay that takes
/// keys without stealing the active app, and a prompt with ghost text from the
/// same daemon the zsh plugin talks to.
///
/// Not here yet, on purpose: no PTY (Enter shows what WOULD run) and no `learn`
/// after a run, so overlay usage does not yet feed the model.
@MainActor
final class Controller {
    private let panel: OverlayPanel
    private let model = PromptModel()
    private let hotKey = HotKey()
    private var flagsMonitor: Any?

    /// Whether ⌥ has been held continuously since the overlay appeared.
    ///
    /// This is what makes ⌥Space behave like a window switcher. The hotkey IS
    /// ⌥Space, so tapping Space again while ⌥ stays down cannot mean "toggle" —
    /// it has to mean "next directory". Releasing ⌥ ends the cycle, and from then
    /// on ⌥Space toggles again.
    private var cycling = false

    init() {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        // Sized to the content, not to the screen: a screen-sized transparent
        // panel swallows every click in its frame, drawn or not.
        let frame = NSRect(x: screen.midX - 400, y: screen.midY - 150, width: 800, height: 300)

        panel = OverlayPanel(contentRect: frame)
        panel.contentView = NSHostingView(rootView: PromptView(model: model))
        model.connect()
    }

    func start() {
        let registered = hotKey.register { [weak self] in self?.hotKeyPressed() }
        if !registered {
            // A dead shortcut with no explanation is worse than a visible failure.
            FileHandle.standardError.write(Data("tabcat-gui: could not register ⌥Space\n".utf8))
        }
        observeModifiers()
        show()
    }

    // MARK: - Hotkey

    private func hotKeyPressed() {
        guard panel.isVisible else {
            show()
            return
        }
        if cycling {
            model.selectNext()
        } else {
            panel.orderOut(nil)
        }
    }

    private func show() {
        // makeKeyAndOrderFront on a nonactivating panel takes the keyboard without
        // making this the active application.
        panel.makeKeyAndOrderFront(nil)
        // The hotkey is a chord, so ⌥ is down right now — unless the user got here
        // some other way, in which case there is nothing to cycle.
        cycling = NSEvent.modifierFlags.contains(.option)
    }

    /// A local monitor is enough: it fires while the panel is key window, which is
    /// exactly when cycling is possible. A global monitor would be TCC-gated and
    /// cost an Accessibility permission for no gain.
    private func observeModifiers() {
        flagsMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { [weak self] event in
            guard let self else { return event }
            switch event.type {
            case .flagsChanged:
                if self.cycling, !event.modifierFlags.contains(.option) {
                    // Release commits the selection, like letting go of ⌥ in the
                    // window switcher. The field already has focus.
                    self.cycling = false
                }
                return event
            case .keyDown:
                // While ⌥ is held, the arrows walk the chip row instead of moving
                // the caret. No mode flag needed beyond `cycling`: the modifier is
                // part of the event.
                guard self.cycling, event.modifierFlags.contains(.option) else { return event }
                switch Int(event.keyCode) {
                case kVK_RightArrow: self.model.selectNext(); return nil
                case kVK_LeftArrow: self.model.selectPrevious(); return nil
                default: return event
                }
            default:
                return event
            }
        }
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
