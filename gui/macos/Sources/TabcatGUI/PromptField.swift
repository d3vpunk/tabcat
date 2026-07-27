import AppKit
import SwiftUI

/// The prompt's editor.
///
/// An owned `NSTextView` rather than SwiftUI's `TextField`, for four reasons that
/// are really one: the ghost and the caret have to come out of the same layout.
///
/// - The ghost used to be a separate `Text`, offset by the measured width of the
///   typed string. Correct until the line outgrew the field — a field scrolls its
///   content and a fixed offset does not, so the ghost drifted off the right edge
///   on exactly the long commands worth completing. Drawn inside the view, it is
///   placed by the same layout that drew the text, and the text wraps instead of
///   scrolling, so there is nothing left to drift.
/// - The caret position had to be fished back out of the field editor from the
///   Controller, and predictions were requested for the end of the line whatever the
///   caret was actually doing.
/// - A pasted multi-line block is simply several lines. The REPL needs a whole mode
///   for it (`pasted` in `prompt-state.ts`) because a terminal prompt is one line;
///   here it costs nothing.
/// - The ghost can be drawn in two weights, so what → takes is visibly less than
///   what Tab takes.
struct PromptField: NSViewRepresentable {
    /// What the editor should show. Pushed down; edits come back through `onEdit`.
    let text: String
    /// Caret position in CODE POINTS — the unit the daemon counts in.
    let caret: Int
    let ghost: String
    /// How much of the ghost → would take, in code points.
    let chunkLength: Int
    /// Text and caret together, because they change together and two separate
    /// bindings would make one prediction for the new text at the old caret.
    let onEdit: (String, Int) -> Void
    let onKey: (PromptKey) -> Bool
    let onSubmit: () -> Void

    enum PromptKey {
        case accept
        case undo
        case chunk
        case up
        case down
        case cancel
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> GhostTextView {
        let view = GhostTextView()
        view.delegate = context.coordinator
        view.isRichText = false
        view.allowsUndo = true
        // A shell line is not prose: a smart quote or an em dash silently changes
        // what runs.
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.isGrammarCheckingEnabled = false
        view.font = Typeface.measuring
        view.textColor = .labelColor
        view.insertionPointColor = .labelColor
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        // Wrap rather than scroll sideways. On an 800 pt panel the whole command
        // stays readable, and a wrapped line is the same thing multi-line input
        // needs anyway.
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }

    func updateNSView(_ view: GhostTextView, context: Context) {
        context.coordinator.parent = self
        // Suspended across BOTH writes, not just the text. `textViewDidChangeSelection`
        // fires for a programmatic selection too, so moving the caret reported itself
        // straight back up as an edit — from inside SwiftUI's own update pass, which
        // is where publishing is undefined behaviour. It fired on every accept, undo
        // and clear, not in some corner case.
        context.coordinator.applying = true
        let replaced = view.string != text
        if replaced {
            view.string = text
        }
        // The caret is only enforced when the model moved it itself — an accept, an
        // undo, a clear. Most updates are the editor's last report echoed straight
        // back, and enforcing the caret on those collapsed every selection in the
        // same round trip that made it: the drag reported its start as the caret,
        // and the echo came back as a zero-length range. After a text replacement
        // it is always enforced — a selection measured against the old line has
        // nothing to survive into.
        let reported = context.coordinator.reported
        if replaced || reported?.text != text || reported?.caret != caret {
            let target = utf16Offset(of: caret, in: text)
            if view.selectedRange() != NSRange(location: target, length: 0) {
                view.setSelectedRange(NSRange(location: target, length: 0))
            }
        }
        context.coordinator.applying = false
        view.ghost = ghost
        view.chunkLength = utf16Offset(of: chunkLength, in: ghost)
        // Focus can be lost to a click on a card or a chip, and the prompt is where
        // typing belongs. Not while a terminal holds a selection: the keyboard is
        // parked there on purpose (`OverlayPanel.sendEvent`), and this runs on every
        // model change — streaming output must not yank it back mid-⌘C.
        if view.window?.firstResponder !== view, view.window?.isKeyWindow == true,
           view.window?.terminalHoldsSelection != true {
            view.window?.makeFirstResponder(view)
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: GhostTextView, context: Context) -> CGSize? {
        guard let container = nsView.textContainer, let layout = nsView.layoutManager else { return nil }
        let width = proposal.width ?? nsView.bounds.width
        container.size = NSSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        // The ghost counts: it is drawn by this view and can wrap onto lines the
        // typed text does not occupy, and a box measured without it would cut them
        // off. One line's worth as a floor, so an empty prompt is not a hairline.
        let used = max(layout.usedRect(for: container).height, nsView.ghostOverhang())
        return CGSize(width: width, height: max(ceil(Typeface.size * 1.35), ceil(used)))
    }

    /// Code points to UTF-16 units — AppKit ranges are UTF-16, the daemon counts
    /// code points, and a line containing an emoji is where the two disagree.
    private func utf16Offset(of codePoints: Int, in string: String) -> Int {
        let scalars = Array(string.unicodeScalars)
        let clamped = min(max(0, codePoints), scalars.count)
        return String(String.UnicodeScalarView(scalars[0..<clamped])).utf16.count
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PromptField
        /// True while a pushed-down value is being written, so it is not reported
        /// back as an edit.
        var applying = false
        /// The last (text, caret) sent up, so an update that merely echoes it can be
        /// told apart from the model moving the caret on its own.
        var reported: (text: String, caret: Int)?

        init(_ parent: PromptField) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard !applying, let view = notification.object as? NSTextView else { return }
            report(view)
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard !applying, let view = notification.object as? NSTextView else { return }
            report(view)
        }

        private func report(_ view: NSTextView) {
            let caret = codePointCaret(view)
            reported = (view.string, caret)
            parent.onEdit(view.string, caret)
        }

        /// The caret in code points.
        private func codePointCaret(_ view: NSTextView) -> Int {
            let location = view.selectedRange().location
            let text = view.string as NSString
            guard location <= text.length else { return view.string.unicodeScalars.count }
            return String(text.substring(to: location)).unicodeScalars.count
        }

        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                parent.onSubmit()
                return true
            case #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
                // ⌥Enter. A command really can span lines, and a paste that contains
                // newlines inserts them without any of this being a mode.
                view.insertText("\n", replacementRange: view.selectedRange())
                return true
            case #selector(NSResponder.insertTab(_:)):
                return parent.onKey(.accept)
            case #selector(NSResponder.insertBacktab(_:)):
                return parent.onKey(.undo)
            case #selector(NSResponder.moveRight(_:)):
                // Only at the very end. Anywhere else → is a caret key, exactly as it
                // is in the REPL and the plugin.
                guard view.selectedRange() == NSRange(location: (view.string as NSString).length, length: 0)
                else { return false }
                return parent.onKey(.chunk)
            case #selector(NSResponder.scrollToBeginningOfDocument(_:)):
                // Home. Cocoa's default scrolls the view; a shell moves the caret.
                // Document rather than line: the buffer is one command, and a line
                // break in it is only the panel's width wrapping it.
                view.moveToBeginningOfDocument(nil)
                return true
            case #selector(NSResponder.scrollToEndOfDocument(_:)):
                // End. Same substitution. ⇧Home/⇧End already move the caret —
                // Cocoa binds those to the AndModifySelection actions.
                view.moveToEndOfDocument(nil)
                return true
            case #selector(NSResponder.moveUp(_:)):
                return parent.onKey(.up)
            case #selector(NSResponder.moveDown(_:)):
                return parent.onKey(.down)
            case #selector(NSResponder.cancelOperation(_:)):
                return parent.onKey(.cancel)
            default:
                return false
            }
        }
    }
}

/// Draws the ghost after the caret, inside the text view's own layout.
final class GhostTextView: NSTextView {
    var ghost = "" {
        didSet { if ghost != oldValue { needsDisplay = true } }
    }

    /// UTF-16 units of the ghost that → would take.
    var chunkLength = 0 {
        didSet { if chunkLength != oldValue { needsDisplay = true } }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard !ghost.isEmpty, drawsGhost else { return }
        guard let origin = ghostOrigin() else { return }
        // Wrapped, not drawn on one endless line. `draw(at:)` lays out without a
        // width and would run a long suggestion off the right edge — the same
        // symptom the old offset ghost had, arrived at a different way. The typed
        // text wraps, so the ghost has to as well.
        ghostText().draw(with: ghostBox(from: origin), options: [.usesLineFragmentOrigin])
    }

    /// The ghost, with its first chunk a step brighter than the rest: → takes the
    /// bright part, Tab takes all of it. Two keys whose difference you can see rather
    /// than discover by pressing them.
    private func ghostText() -> NSAttributedString {
        let drawn = NSMutableAttributedString(string: ghost, attributes: [
            .font: Typeface.measuring,
            .foregroundColor: NSColor.tertiaryLabelColor,
        ])
        if chunkLength > 0 {
            drawn.addAttribute(
                .foregroundColor,
                value: NSColor.secondaryLabelColor,
                range: NSRange(location: 0, length: min(chunkLength, drawn.length))
            )
        }
        return drawn
    }

    /// From where the text ended to the right edge of the container, and as far down
    /// as it needs. The first line is short by however much the typed text used.
    private func ghostBox(from origin: NSPoint) -> NSRect {
        let width = max(1, (textContainer?.size.width ?? bounds.width) + textContainerOrigin.x - origin.x)
        return NSRect(x: origin.x, y: origin.y, width: width, height: .greatestFiniteMagnitude)
    }

    /// How much room the ghost needs below the text it follows, so the view can be
    /// tall enough for it. Zero when there is none, or when the caret is not at the
    /// end and therefore nothing is drawn.
    func ghostOverhang() -> CGFloat {
        guard !ghost.isEmpty, drawsGhost, let origin = ghostOrigin() else { return 0 }
        let box = ghostText().boundingRect(
            with: NSSize(width: ghostBox(from: origin).width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin]
        )
        return origin.y + box.height
    }

    /// A ghost is drawn after the caret, so anywhere but the very end it would
    /// describe a completion of something other than what it appears to follow.
    private var drawsGhost: Bool {
        let selection = selectedRange()
        return selection.length == 0 && selection.location == (string as NSString).length
    }

    /// Where the text ends, in view coordinates.
    private func ghostOrigin() -> NSPoint? {
        guard let layout = layoutManager, let container = textContainer else { return nil }
        let length = (string as NSString).length
        let inset = textContainerOrigin
        guard length > 0 else { return inset }
        layout.ensureLayout(for: container)
        let glyphs = layout.glyphRange(
            forCharacterRange: NSRange(location: length - 1, length: 1),
            actualCharacterRange: nil
        )
        let rect = layout.boundingRect(forGlyphRange: glyphs, in: container)
        return NSPoint(x: rect.maxX + inset.x, y: rect.minY + inset.y)
    }
}
