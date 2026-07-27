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
    private let combo = HotKeyCombo.configured()
    private var flagsMonitor: Any?
    private var observer: AnyCancellable?
    private var screenObserver: NSObjectProtocol?
    private var shrinkTask: Task<Void, Never>?

    /// Whichever screen the overlay belongs on right now. Never cached across a
    /// showing: displays come and go.
    private var layout: Layout { model.layout }

    /// Whether the hotkey's modifiers have been held continuously since the launcher
    /// appeared.
    ///
    /// This is what makes the hotkey behave like a window switcher. Tapping its key
    /// again while its modifiers stay down cannot mean "toggle" — it has to mean
    /// "next directory". Releasing them ends the cycle, and the hotkey toggles again.
    ///
    /// Keyed off whichever modifiers the combination actually has, not off ⌥: the
    /// hotkey is configurable, and hard-coding one modifier would silently drop the
    /// cycle for everyone who changed it.
    private var cycling = false

    init() {
        model.layout = .onPointerScreen()
        let frame = model.layout.panelOpen(badges: 0)
        panel = OverlayPanel(contentRect: frame)
        model.panelFrame = frame
        panel.contentView = FirstMouseHostingView(rootView: OverlayContent(model: model))
        model.connect()
    }

    func start() {
        let registered = hotKey.register(combo) { [weak self] in self?.hotKeyPressed() }
        if !registered {
            // A dead shortcut with no explanation is worse than a visible failure.
            //
            // Both channels on purpose: stderr is what a `swift run` shows, and the
            // bundled app has no terminal attached at all — there `log stream` is the
            // only way to see this, which is the command `bundle.sh` prints.
            // Named, because the log interpolation is an autoclosure and would
            // otherwise have to capture self to reach the property.
            let described = combo.description
            FileHandle.standardError.write(Data("tabcat-gui: could not register \(described)\n".utf8))
            Log.app.error("could not register \(described, privacy: .public)")
        }
        observeModifiers()
        // Escape that nothing in the content took. The panel asks rather than hiding
        // itself, so the flag and the window cannot disagree.
        //
        // Finished runs go with it. Escape means away with all of it, and a badge for
        // something that already ended has nothing left to say — unlike the automatic
        // cleanup, which spares failures on purpose. What is still running stays in
        // the corner.
        panel.onCancel = { [weak self] in self?.dismiss() }
        // A click on the panel where nothing is drawn. Same intent as Escape with an
        // empty prompt and nothing in front, so it is the same code — one definition of
        // "away" rather than two that drift.
        model.onDismiss = { [weak self] in self?.dismiss() }
        // Focus taken by something else. Not the same as Escape: Escape is a decision,
        // this can be a notification or an application raising a window on its own, so
        // it gives up the keyboard and the launcher WITHOUT dropping finished badges.
        // Losing a run's output to an accident nobody asked for would be the worse
        // trade by far.
        panel.onFocusLost = { [weak self] in
            guard let self, self.model.launcherVisible else { return }
            self.hideLauncher()
        }
        // A badge brought back to the front needs the launcher back too: the card is
        // positioned under it, and without it the panel has shrunk to the rail.
        model.onReveal = { [weak self] in self?.showLauncher() }
        // The frame depends on what is on screen, and that changes from several
        // places — a card being minimised, a run finishing, the launcher closing.
        // Reacting to the model beats remembering to call this at every one of them.
        observer = model.objectWillChange.sink { [weak self] _ in
            // objectWillChange fires BEFORE the value lands, so the new state is only
            // readable one turn later.
            DispatchQueue.main.async { self?.applyFrame() }
        }
        // A display unplugged, added, or resized invalidates every coordinate. The
        // rail in particular is pinned to a corner that may no longer exist, and
        // nothing else would ever move it: the overlay only recomputes on opening,
        // and badges outlive that.
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.model.layout = .onPointerScreen()
                self.applyFrame()
            }
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
        // Recomputed every time, for the screen the pointer is on. A layout held from
        // launch described whatever display was attached then — unplug it and the
        // overlay kept opening at coordinates belonging to a screen that was gone.
        model.layout = .onPointerScreen()
        model.launcherVisible = true
        applyFrame()
        // makeKeyAndOrderFront on a nonactivating panel takes the keyboard without
        // making this the active application.
        panel.makeKeyAndOrderFront(nil)
        // The overlay can sit unused for hours, by which time the daemon has idled
        // out. Healing here means the first keystroke after a break already has
        // predictions, instead of being the thing that discovers the problem.
        model.refresh()
        // The hotkey is a chord, so its modifiers are down right now — unless the user
        // got here some other way, in which case there is nothing to cycle.
        cycling = NSEvent.modifierFlags.isSuperset(of: combo.held)
    }

    /// The whole overlay, put away deliberately.
    ///
    /// Finished runs go with it. Away means away with all of it, and a badge for
    /// something that already ended has nothing left to say — unlike the automatic
    /// cleanup, which spares failures on purpose. What is still running stays in the
    /// corner, because that is the entire reason the rail outlives the launcher.
    private func dismiss() {
        model.dismissFinished()
        hideLauncher()
    }

    private func hideLauncher() {
        model.launcherVisible = false
        cycling = false
        // A card in front is positioned under a launcher that is no longer there, and
        // the frame shrinks to the rail a moment later and would clip it. Putting it
        // away is also what the gesture means: away with all of it, not just the
        // prompt. Its output is not lost — the badge brings it back.
        model.minimizeForeground()
        // A nonactivating panel that is key receives keystrokes system-wide, and it
        // stays key until something else takes over. With the launcher gone there is
        // no prompt left to take them, so everything typed into the app the user went
        // back to was being swallowed by an invisible window. Ordering out resigns
        // key; ordering straight back in leaves the rail on screen without taking it
        // again. When no runs are left, applyFrame orders out for good anyway.
        if panel.isKeyWindow {
            panel.orderOut(nil)
            if !model.runs.isEmpty { panel.orderFront(nil) }
        }
    }

    // MARK: - Frame
    //
    // Spike 1: a panel swallows every click inside its frame, drawn or not. So the
    // frame has to shrink to the rail once the launcher is gone, or the middle of the
    // screen would stay dead while a badge sits in the corner.

    private func applyFrame() {
        shrinkTask?.cancel()

        let badges = model.badges.count
        if model.launcherVisible {
            setFrame(layout.panelOpen(badges: badges))
            if !panel.isVisible { panel.makeKeyAndOrderFront(nil) }
            return
        }
        if model.runs.isEmpty {
            panel.orderOut(nil)
            return
        }
        // Growing is immediate, shrinking waits. A card travelling to the corner is
        // mid-flight right now, and a frame that shrank under it would clip it —
        // Core Animation and SwiftUI do not share a clock. How long to wait is derived
        // from the spring itself, in `Motion`.
        shrinkTask = Task { [weak self] in
            try? await Task.sleep(for: Motion.settle)
            guard let self, !Task.isCancelled, !self.model.launcherVisible, !self.model.runs.isEmpty else { return }
            self.setFrame(self.layout.panelClosed(badges: self.model.badges.count))
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
                if self.cycling, !event.modifierFlags.isSuperset(of: self.combo.held) {
                    // Release commits the selection, like letting go of ⌘ in the
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
                    // By character and not by key code, for the same reason as the
                    // digits: R is wherever the layout put it.
                    if event.charactersIgnoringModifiers == "r" {
                        return self.model.rerunForeground() ? nil : event
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
                // While the hotkey's modifiers are held, the arrows walk the chip row
                // instead of moving the caret. No mode flag needed beyond `cycling`:
                // the modifiers are part of the event.
                guard self.cycling, event.modifierFlags.isSuperset(of: self.combo.held) else { return event }
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
// The tables alone: no daemon, no socket, no pty, so a build runner can gate on them.
if CommandLine.arguments.contains("--tables") {
    exit(Check.tables())
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
