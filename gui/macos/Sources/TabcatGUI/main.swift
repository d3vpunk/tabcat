import AppKit
import Carbon.HIToolbox
import Combine
import SwiftUI

/// The third tabcat front end: a global hotkey, an overlay that takes keys without
/// stealing the active app, a prompt with ghost text from the same daemon the zsh
/// plugin talks to, and runs that can be sent to a rail in the corner.
///
/// Not here yet: interactive commands (no way to send input, so a `sudo` prompt
/// hangs) and full terminal emulation (no cursor addressing, so `vim` renders wrong).
@MainActor
final class Controller {
    private let panel: OverlayPanel
    private let model = PromptModel()
    private let hotKey = HotKey()
    private let layout = Layout()
    private var flagsMonitor: Any?
    private var observer: AnyCancellable?
    private var shrinkTask: Task<Void, Never>?

    /// Whether ⌥ has been held continuously since the launcher appeared.
    ///
    /// This is what makes ⌥Space behave like a window switcher. The hotkey IS
    /// ⌥Space, so tapping Space again while ⌥ stays down cannot mean "toggle" —
    /// it has to mean "next directory". Releasing ⌥ ends the cycle, and from then
    /// on ⌥Space toggles again.
    private var cycling = false

    init() {
        panel = OverlayPanel(contentRect: layout.panelOpen)
        model.panelFrame = layout.panelOpen
        panel.contentView = NSHostingView(rootView: OverlayContent(model: model, layout: layout))
        model.connect()
    }

    func start() {
        let registered = hotKey.register { [weak self] in self?.hotKeyPressed() }
        if !registered {
            // A dead shortcut with no explanation is worse than a visible failure.
            FileHandle.standardError.write(Data("tabcat-gui: could not register ⌥Space\n".utf8))
        }
        observeModifiers()
        // The frame depends on what is on screen, and that changes from several
        // places — a card being minimised, a run finishing, the launcher closing.
        // Reacting to the model beats remembering to call this at every one of them.
        observer = model.objectWillChange.sink { [weak self] _ in
            // objectWillChange fires BEFORE the value lands, so the new state is only
            // readable one turn later.
            DispatchQueue.main.async { self?.applyFrame() }
        }
        showLauncher()
    }

    // MARK: - Hotkey

    private func hotKeyPressed() {
        guard model.launcherVisible, panel.isVisible else {
            showLauncher()
            return
        }
        if cycling {
            model.selectNext()
        } else {
            hideLauncher()
        }
    }

    private func showLauncher() {
        model.launcherVisible = true
        applyFrame()
        // makeKeyAndOrderFront on a nonactivating panel takes the keyboard without
        // making this the active application.
        panel.makeKeyAndOrderFront(nil)
        // The overlay can sit unused for hours, by which time the daemon has idled
        // out. Healing here means the first keystroke after a break already has
        // predictions, instead of being the thing that discovers the problem.
        model.refresh()
        // The hotkey is a chord, so ⌥ is down right now — unless the user got here
        // some other way, in which case there is nothing to cycle.
        cycling = NSEvent.modifierFlags.contains(.option)
    }

    private func hideLauncher() {
        model.launcherVisible = false
        cycling = false
    }

    // MARK: - Frame
    //
    // Spike 1: a panel swallows every click inside its frame, drawn or not. So the
    // frame has to shrink to the rail once the launcher is gone, or the middle of the
    // screen would stay dead while a badge sits in the corner.

    private func applyFrame() {
        shrinkTask?.cancel()

        if model.launcherVisible {
            setFrame(layout.panelOpen)
            if !panel.isVisible { panel.makeKeyAndOrderFront(nil) }
            return
        }
        if model.runs.isEmpty {
            panel.orderOut(nil)
            return
        }
        // Growing is immediate, shrinking waits. A card travelling to the corner is
        // mid-flight right now, and a frame that shrank under it would clip it —
        // Core Animation and SwiftUI do not share a clock.
        shrinkTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            guard let self, !Task.isCancelled, !self.model.launcherVisible, !self.model.runs.isEmpty else { return }
            self.setFrame(self.layout.panelClosed)
        }
    }

    /// Moves the window and tells the view about it in the same turn. The content's
    /// positions are screen rects, so nothing moves visually — which is what allows
    /// the frame to change without fighting an animation.
    private func setFrame(_ frame: NSRect) {
        guard panel.frame != frame else { return }
        panel.setFrame(frame, display: true)
        model.panelFrame = frame
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
                // Command combinations are offered to the menu bar as key equivalents
                // BEFORE the responder chain sees them. This app has no menu bar, so
                // they would probably arrive anyway — but a local monitor runs ahead
                // of both, so there is nothing left to probably.
                if event.modifierFlags.contains(.command) {
                    if let digit = event.charactersIgnoringModifiers.flatMap({ Int($0) }), digit >= 1, digit <= 9 {
                        return self.model.select(digit: digit) ? nil : event
                    }
                    switch Int(event.keyCode) {
                    case kVK_Return:
                        self.model.confirmPending()
                        return nil
                    case kVK_DownArrow:
                        // Send the card away — the gesture the overlay was designed
                        // around.
                        self.model.minimizeForeground()
                        return nil
                    default:
                        break
                    }
                }
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
// Separate flag because it appends a history entry, unlike --check.
if CommandLine.arguments.contains("--selftest") {
    exit(await Check.selftest())
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
