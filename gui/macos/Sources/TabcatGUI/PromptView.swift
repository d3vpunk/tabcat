import AppKit
import SwiftUI

/// Named explicitly rather than `.system(design: .monospaced)`: the ghost's offset
/// is measured with an NSFont and drawn with a SwiftUI Font, and only the same
/// family and size on both sides guarantees the metrics cannot drift apart.
enum Typeface {
    static let name = "Menlo"
    static let size: CGFloat = 15
    static let measuring = NSFont(name: name, size: size)
        ?? .monospacedSystemFont(ofSize: size, weight: .regular)
    static var swiftUI: Font { .custom(name, size: size) }
    static func small(_ size: CGFloat) -> Font { .custom(name, size: size) }
}

struct PromptView: View {
    @ObservedObject var model: PromptModel
    @Namespace private var chipGlass
    /// Which wordmark to draw: the glass follows the system appearance, and half the
    /// logo is near-black.
    @Environment(\.colorScheme) private var colorScheme
    /// Which list row the pointer is over, for the hover-revealed x. One value
    /// rather than per-row state: only one row can be hovered at a time, and a
    /// row that scrolls out from under the pointer must not keep its x.
    @State private var hoveredRow: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            breadcrumb
            field
            // The gear swaps the candidate list for the settings panel inside the
            // same glass — no second window, no activation dance.
            if model.settingsVisible {
                SettingsPanel(model: model)
            } else if !model.suggestions.isEmpty {
                list
            }
            footer
        }
        .padding(26)
        // The glass hugs the content, so the confirmation card makes it taller and
        // the empty rest of the launcher box stays transparent. .continuous is not
        // cosmetic: the default .circular reads as a hard corner, unlike the Dock.
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        // The glass swallows its own clicks. A Text without a gesture does not
        // block the tap gesture BEHIND it, and behind the launcher sits the
        // dismiss layer — so a click on a label or a gap read as "beside the
        // overlay" and closed it. Buttons and rows inside still win: child
        // gestures take precedence over this one. The area below the glass,
        // inside the box, stays dismissive — visually it IS beside.
        .contentShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .onTapGesture {}
        // The run card is placed directly below this, so its position depends on how
        // tall this actually turned out — which changes when a confirmation card
        // appears.
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
            model.launcherHeight = height
        }
    }

    // MARK: - Header row

    /// Chips on the left, the window controls on the right: gear, then the close
    /// X in the outermost corner where every window keeps it. The X does what a
    /// click beside the launcher does — same intent, same code — it just makes
    /// the way out visible instead of relying on everyone knowing the gesture.
    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            chips
            Spacer(minLength: 12)
            Button { model.toggleSettings() } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 12))
                    .foregroundStyle(model.settingsVisible ? .secondary : .tertiary)
            }
            .buttonStyle(.plain)
            .help("Settings")
            Button { model.onDismiss?() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
            .help("Close")
        }
    }

    // MARK: - Directory chips

    private var chips: some View {
        // A container so neighbouring chips merge into one segmented surface
        // instead of reading as loose pills.
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                ForEach(Array(model.chips.enumerated()), id: \.element.id) { index, directory in
                    chip(directory, index: index)
                }
            }
        }
    }

    private func chip(_ directory: Directory, index: Int) -> some View {
        let active = index == model.selection
        // No per-chip marker for guessed directories: the status line already says
        // the whole row was guessed, and an icon on every chip only ate the space
        // the label needs.
        return HStack(spacing: 7) {
            Text(directory.label())
                .font(Typeface.small(12))
                .fixedSize()
            // Kept even though it costs width: it is the only thing that makes the
            // ⌘-digit shortcut discoverable.
            Text("\(index + 1)")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .foregroundStyle(active ? .primary : .secondary)
        .glassEffect(active ? .regular : .clear, in: Capsule())
        .glassEffectUnion(id: "chips", namespace: chipGlass)
        .contentShape(Capsule())
        // A row of directories that can only be reached by keyboard is a keyboard
        // shortcut wearing a button's clothes.
        .onTapGesture { model.select(index) }
    }

    /// The working directory, one clickable component at a time.
    ///
    /// It replaces a plain path line, which said where you were and offered nothing.
    /// The frequent move is into a subfolder and back out again, and a breadcrumb
    /// makes the way back one click instead of a typed `cd ..` — a terminal cannot
    /// offer that, which is most of the reason to build this as a real interface.
    ///
    /// No chip is active while the prompt sits somewhere the row does not list, and
    /// that is honest rather than a gap: the row ranks where you work, the breadcrumb
    /// says where you are.
    private var breadcrumb: some View {
        HStack(spacing: 3) {
            ForEach(Array(model.breadcrumb.enumerated()), id: \.element.id) { index, crumb in
                if index > 0 {
                    Text("/").foregroundStyle(.quaternary)
                }
                Button(crumb.label) { model.navigate(to: crumb.path) }
                    .buttonStyle(.plain)
                    .foregroundStyle(index == model.breadcrumb.count - 1 ? .secondary : .tertiary)
            }
        }
        .font(Typeface.small(11))
        .lineLimit(1)
    }

    // MARK: - Prompt

    private var field: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("❯")
                .font(Typeface.swiftUI)
                .foregroundStyle(.secondary)
                .frame(height: Typeface.size * 1.35)

            PromptField(
                text: model.typed,
                caret: model.caret,
                ghost: model.ghost,
                chunkLength: model.ghostChunkLength,
                onEdit: { text, caret in model.edit(text: text, caret: caret) },
                onKey: key,
                onSubmit: { model.submit() }
            )

            if !model.handle.isEmpty {
                Text("⚡\(model.handle)")
                    .font(Typeface.small(11))
                    .foregroundStyle(.secondary)
                    .frame(height: Typeface.size * 1.35)
            }
        }
        // ⌘1…⌘9 and ⌥-cycling are NOT handled here: Command combinations go to the
        // menu bar as key equivalents before the responder chain, so the Controller's
        // local event monitor claims them — that runs ahead of both. Everything the
        // EDITOR owns arrives through `key` below instead, from the text view's own
        // doCommandBy — which is where the field editor would otherwise silently keep
        // Tab, → and the arrows for itself.
    }

    /// The editor keys the prompt claims. Returning false leaves the key to the text
    /// view, which is what makes → a caret key wherever it is not an accept.
    private func key(_ key: PromptField.PromptKey) -> Bool {
        switch key {
        case .accept:
            return model.tab()
        case .undo:
            return model.undoAccept()
        case .chunk:
            return model.acceptChunk()
        case .up:
            return model.moveSelection(by: -1)
        case .down:
            return model.moveSelection(by: 1)
        case .cancel:
            // One rung at a time, and the order is what makes it predictable: close
            // the settings panel, drop a held-back command, free the prompt line, put
            // the card in front away, and only with nothing left to tidy does Escape
            // mean the whole overlay.
            //
            // The last rung is NOT claimed here — `cancelOperation:` travels up the
            // responder chain to the panel, so the window and the flag cannot disagree
            // about whether the overlay is up.
            if model.settingsVisible {
                model.closeSettings()
                return true
            }
            if model.pending != nil {
                model.discardPending()
                return true
            }
            if !model.typed.isEmpty {
                model.clear()
                return true
            }
            // The card goes to the rail rather than away: minimising is not closing,
            // and its output comes back with the badge. It is also the same thing ⌘↓
            // does, so Escape cannot end up meaning something ⌘↓ does not.
            if model.minimizeForeground() {
                return true
            }
            return false
        }
    }

    // MARK: - Candidates

    /// Everything the daemon can say about this line, in one place.
    ///
    /// Three sources, three sections. Completions from `predict`, which can only match
    /// a prefix — the ghost shows one of them and even then only when it appends, so a
    /// candidate that corrects the spelling or expands a handle used to be invisible as
    /// well as unreachable. History from `search`, which matches anywhere in the line
    /// and is therefore what retires ^R. Directories from `cwds`, which is how the
    /// sixth-ranked one is reachable at all now that the chip row shows five.
    ///
    /// Shown on an empty line too: that is the frecency ranking for this directory
    /// plus the last commands anywhere, and opening a launcher onto "what you usually
    /// do here" is the whole point.
    ///
    /// Six rows on screen. The rest scrolls rather than being cut off — the daemon
    /// ranks up to fifty and a list that simply ended at the sixth would look like
    /// there was no seventh.
    private static let visibleRows = 6
    private static let rowHeight: CGFloat = 22
    private static let rowSpacing: CGFloat = 1
    private static let headerHeight: CGFloat = 15

    /// Six rows, plus the headers standing between them.
    ///
    /// The headers are counted rather than absorbed. This number is the scroll view's
    /// frame, so a viewport measured for rows alone would show five and clip the sixth
    /// the moment a section began — and a clipped row looks like a list that ended.
    /// One constant for the arithmetic and for the drawn header, so the frame cannot
    /// promise a row the view does not draw.
    private var listHeight: CGFloat {
        let visible = model.suggestions.prefix(Self.visibleRows)
        let headers = visible.filter { $0.header != nil }.count
        return CGFloat(visible.count) * Self.rowHeight
            + CGFloat(headers) * (Self.headerHeight + Self.rowSpacing)
            + CGFloat(max(0, visible.count - 1)) * Self.rowSpacing
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 5) {
            // A real scroll view and not the REPL's sliding window: the window exists
            // because a terminal can only redraw the rows it owns. Here the wheel and
            // the trackpad work for free, and the selection is scrolled into view
            // rather than the view being recomputed around it.
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: Self.rowSpacing) {
                        ForEach(model.suggestions) { entry in
                            VStack(alignment: .leading, spacing: Self.rowSpacing) {
                                if let header = entry.header {
                                    sectionHeader(header)
                                }
                                row(entry)
                            }
                            // The header travels with its first row, so scrolling the
                            // selection into view brings the label that explains it.
                            .id(entry.index)
                        }
                    }
                }
                // Fixed rather than measured, so the launcher's height — which the run
                // card below is positioned against — does not depend on how a row
                // happened to lay out.
                .frame(height: listHeight)
                .scrollBounceBehavior(.basedOnSize)
                .onChange(of: model.selected) { _, index in
                    withAnimation(.easeOut(duration: 0.12)) {
                        proxy.scrollTo(index, anchor: .center)
                    }
                }
            }
            if model.suggestions.count > Self.visibleRows {
                Text("\(model.selected + 1)/\(model.suggestions.count)")
                    .font(Typeface.small(9))
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 8)
            }
        }
    }

    /// Quiet, and only where the list changes subject. The completions have none: they
    /// are what the prompt line continues into, and a label over them names the default.
    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(Typeface.small(9))
            .foregroundStyle(.tertiary)
            .padding(.leading, 8)
            .frame(height: Self.headerHeight, alignment: .bottomLeading)
    }

    private func row(_ entry: Suggestions.Row) -> some View {
        let isSelected = entry.index == model.selected
        return HStack(spacing: 8) {
            Text(isSelected ? "›" : " ")
                .foregroundStyle(.tertiary)
            content(entry.suggestion)
            Spacer(minLength: 8)
            if let marker = marker(for: entry.suggestion) {
                Text(marker)
                    .font(Typeface.small(9))
                    .foregroundStyle(.tertiary)
            }
            // Wherever a history entry stands behind the row (the model
            // decides — history hits and history-fed completions, never fs,
            // magic or directories). Revealed on hover — an x on every row
            // would be noise — and kept on the selected row so it exists for
            // the keyboard's eye too.
            if model.canForget(entry), hoveredRow == entry.index || isSelected {
                Button { model.forget(entry) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Remove from history")
            }
        }
        .font(Typeface.small(12))
        .foregroundStyle(isSelected ? .primary : .secondary)
        .padding(.horizontal, 8)
        .frame(height: Self.rowHeight)
        .background {
            if isSelected {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(.primary.opacity(0.09))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { model.choose(entry.index) }
        .onHover { inside in
            if inside {
                hoveredRow = entry.index
            } else if hoveredRow == entry.index {
                hoveredRow = nil
            }
        }
    }

    @ViewBuilder
    private func content(_ suggestion: Suggestion) -> some View {
        switch suggestion {
        case let .completion(candidate):
            if candidate.magicName.isEmpty {
                typedPrefixDimmed(candidate)
            } else {
                // The handle is what you type, the command is what happens — so the
                // row shows both, and the row itself is the expansion preview.
                Text("⚡\(candidate.magicName)")
                    .foregroundStyle(.purple)
                Text(candidate.display)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        case let .history(line):
            // Nothing dimmed: a fuzzy hit matches scattered through the line, so there
            // is no prefix that repeats what was typed and marking the matched letters
            // would light up single characters across the row.
            Text(line)
                .lineLimit(1)
                .truncationMode(.middle)
        case let .directory(directory):
            Text(PathLabel.full(of: directory.path))
                .lineLimit(1)
                // From the front, where a path carries the least: every path on the
                // machine begins the same way and the last component is the name.
                .truncationMode(.head)
        }
    }

    /// The marker in the right-hand column. `·cd` earns its place: it is the one row
    /// where Enter does something other than fill the line in, and the column that
    /// already says where a row came from is where a reader looks for that.
    private func marker(for suggestion: Suggestion) -> String? {
        switch suggestion {
        case let .completion(candidate): return sourceMarker(candidate.source)
        case .history: return nil
        case .directory: return "·cd"
        }
    }

    /// The part of a row that repeats what was typed is dimmed, so the eye lands on
    /// what would be added.
    ///
    /// Derived from `insert`, which is the display minus exactly that prefix — the
    /// wire does not carry its length on its own, and recomputing it here would mean
    /// guessing at the escaping a filesystem candidate went through.
    @ViewBuilder
    private func typedPrefixDimmed(_ candidate: Candidate) -> some View {
        let shared = candidate.display.hasSuffix(candidate.insert) && !candidate.insert.isEmpty
            ? String(candidate.display.dropLast(candidate.insert.count))
            : ""
        HStack(spacing: 0) {
            if !shared.isEmpty {
                Text(shared).foregroundStyle(.tertiary)
            }
            Text(String(candidate.display.dropFirst(shared.count)))
        }
        .lineLimit(1)
        .truncationMode(.middle)
    }

    /// Same two markers the REPL uses: a filesystem hit, or one the history and the
    /// filesystem agree on.
    private func sourceMarker(_ source: String) -> String? {
        switch source {
        case "fs": return "·fs"
        case "both": return "·✓"
        default: return nil
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let pending = model.pending {
                ConfirmCard(pending: pending)
            }
            // Status and wordmark share the bottom line, aligned on their baselines.
            // The status wraps when it is long and the mark stays in the corner, which
            // is why it sits in this row rather than in an overlay: a mark drawn over
            // the glass would land on top of a long message instead of beside it.
            HStack(alignment: .bottom, spacing: 12) {
                Text(model.status)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 12)
                wordmark
            }
        }
    }

    /// Bottom right, quiet on purpose: it says whose window this is, and it must not
    /// compete with the line of status text beside it.
    @ViewBuilder private var wordmark: some View {
        if let image = Branding.wordmark(dark: colorScheme == .dark) {
            Image(nsImage: image)
                .resizable()
                .scaledToFit()
                .frame(height: 13)
                .opacity(0.75)
                // Decoration. It carries no information a screen reader has not already
                // been told by the window itself.
                .accessibilityHidden(true)
        }
    }

}
