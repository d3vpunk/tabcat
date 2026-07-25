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
}

struct PromptView: View {
    @ObservedObject var model: PromptModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            directory
            field
            footer
        }
        .padding(26)
        .frame(width: 720, alignment: .leading)
        // .continuous is not cosmetic: the default .circular reads as a hard
        // corner and does not match the Dock.
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { focused = true }
    }

    private var directory: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            Text(abbreviated(model.cwd))
                .font(.custom(Typeface.name, size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.head)
        }
    }

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
                    .font(.custom(Typeface.name, size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(height: Typeface.size * 1.7)
        // Tab would move focus and Right-Arrow would move the caret; both are the
        // natural accept keys, so both are intercepted — but only while a ghost is
        // actually there, otherwise the caret must behave normally.
        .onKeyPress(.tab) { model.acceptGhost() ? .handled : .ignored }
        .onKeyPress(.rightArrow) { model.acceptGhost() ? .handled : .ignored }
        .onKeyPress(.escape) {
            model.clear()
            return .handled
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.wouldRun.isEmpty {
                ForEach(model.wouldRun.suffix(3), id: \.self) { line in
                    Text("would run: \(line)")
                        .font(.custom(Typeface.name, size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
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
