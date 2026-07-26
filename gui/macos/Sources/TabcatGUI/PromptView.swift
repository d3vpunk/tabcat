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

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            chips
            breadcrumb
            field
            if !model.candidates.isEmpty {
                list
            }
            footer
        }
        .padding(26)
        // The glass hugs the content, so the confirmation card makes it taller and
        // the empty rest of the launcher box stays transparent. .continuous is not
        // cosmetic: the default .circular reads as a hard corner, unlike the Dock.
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        // The run card is placed directly below this, so its position depends on how
        // tall this actually turned out — which changes when a confirmation card
        // appears.
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
            model.launcherHeight = height
        }
    }

    // MARK: - Directory chips

    private var chips: some View {
        // A container so neighbouring chips merge into one segmented surface
        // instead of reading as loose pills.
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                ForEach(Array(model.directories.enumerated()), id: \.element.id) { index, directory in
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
            // Accept, or step to the next candidate when there is nothing left to
            // accept — the double meaning Tab has in the REPL
            // (`prompt-state.ts:163`), for every command already typed out in full.
            if !model.acceptCurrent() { model.moveSelection(by: 1) }
            return true
        case .undo:
            return model.undoAccept()
        case .chunk:
            return model.acceptChunk()
        case .up:
            return model.moveSelection(by: -1)
        case .down:
            return model.moveSelection(by: 1)
        case .cancel:
            // One job at a time, most urgent to undo first: drop a held-back command,
            // then clear the line. With nothing left to take back, the key is NOT
            // claimed — `cancelOperation:` then travels up the responder chain to the
            // panel, which hides the overlay. Escape closing a launcher is the one
            // convention on this system every user already has, and until now nothing
            // but the hotkey could put the overlay away.
            if model.pending != nil {
                model.discardPending()
                return true
            }
            if !model.typed.isEmpty {
                model.clear()
                return true
            }
            return false
        }
    }

    // MARK: - Candidates

    /// Every candidate, not just the one the ghost can show.
    ///
    /// The ghost is drawn after the caret, so it can only ever append — a candidate
    /// that corrects the spelling or a handle that expands to something else shows
    /// nothing at all, and used to be invisible as well as unreachable. The list has
    /// no such constraint, which is the plainest reason a real interface beats a
    /// single line of terminal.
    ///
    /// Shown on an empty line too: that is the frecency ranking for this directory,
    /// and opening a launcher onto "what you usually do here" is the whole point.
    /// Six rows on screen. The rest scrolls rather than being cut off — the daemon
    /// ranks up to fifty and a list that simply ended at the sixth would look like
    /// there was no seventh.
    private static let visibleRows = 6
    private static let rowHeight: CGFloat = 22
    private static let rowSpacing: CGFloat = 1

    private var listHeight: CGFloat {
        let rows = min(model.candidates.count, Self.visibleRows)
        return CGFloat(rows) * Self.rowHeight + CGFloat(max(0, rows - 1)) * Self.rowSpacing
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
                        ForEach(Array(model.candidates.enumerated()), id: \.offset) { index, candidate in
                            row(candidate, index: index).id(index)
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
            if model.candidates.count > Self.visibleRows {
                Text("\(model.selected + 1)/\(model.candidates.count)")
                    .font(Typeface.small(9))
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 8)
            }
        }
    }

    private func row(_ candidate: Candidate, index: Int) -> some View {
        let isSelected = index == model.selected
        return HStack(spacing: 8) {
            Text(isSelected ? "›" : " ")
                .foregroundStyle(.tertiary)
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
            Spacer(minLength: 8)
            if let marker = sourceMarker(candidate.source) {
                Text(marker)
                    .font(Typeface.small(9))
                    .foregroundStyle(.tertiary)
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
        .onTapGesture { model.choose(index) }
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
            Text(model.status)
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
        }
    }

}
