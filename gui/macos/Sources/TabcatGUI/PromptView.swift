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
    @FocusState private var focused: Bool
    @Namespace private var chipGlass

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            chips
            selectedPath
            field
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
        .onAppear { focused = true }
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
    }

    /// The chip label is only the last path component, which is ambiguous between
    /// two repositories that both have a `src`. Spelling out the selected one costs
    /// a line and removes the guesswork.
    private var selectedPath: some View {
        Text(abbreviated(model.cwd))
            .font(Typeface.small(11))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.head)
    }

    // MARK: - Prompt

    private var field: some View {
        HStack(spacing: 10) {
            Text("❯")
                .font(Typeface.swiftUI)
                .foregroundStyle(.secondary)

            ZStack(alignment: .leading) {
                // Decoration only: shifted right by exactly the typed text's width
                // so it continues the line, and it takes neither click nor caret.
                Text(model.ghost)
                    .font(Typeface.swiftUI)
                    .foregroundStyle(.tertiary)
                    .offset(x: typedWidth)
                    .allowsHitTesting(false)

                TextField("", text: $model.typed)
                    .textFieldStyle(.plain)
                    .font(Typeface.swiftUI)
                    .focused($focused)
                    .onSubmit { model.submit() }
            }

            if !model.handle.isEmpty {
                Text("⚡\(model.handle)")
                    .font(Typeface.small(11))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(height: Typeface.size * 1.7)
        // Tab would move focus and Right-Arrow would move the caret; both are the
        // natural accept keys, so both are intercepted — but only while a ghost is
        // actually there, otherwise the caret must behave normally.
        .onKeyPress(.tab) { model.acceptGhost() ? .handled : .ignored }
        .onKeyPress(.rightArrow) { model.acceptGhost() ? .handled : .ignored }
        // Escape has one job at a time, in order of what is most urgent to undo:
        // drop a held-back command, then clear the line, then dismiss the run.
        .onKeyPress(.escape) {
            if model.pending != nil {
                model.discardPending()
            } else if !model.typed.isEmpty {
                model.clear()
            } else {
                model.dismissForeground()
            }
            return .handled
        }
        // ⌘1…⌘9 are NOT handled here: Command combinations go to the menu bar as
        // key equivalents before the responder chain, so the Controller's local
        // event monitor claims them instead — that runs ahead of both.
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

    /// Where the ghost begins. Exact because this font is the one the field draws.
    private var typedWidth: CGFloat {
        NSAttributedString(string: model.typed, attributes: [.font: Typeface.measuring]).size().width
    }

    private func abbreviated(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }
}
