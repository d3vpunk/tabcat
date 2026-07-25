import AppKit
import SwiftUI

/// Everything the panel draws.
///
/// Cards are positioned absolutely rather than stacked in a VStack, and that is not
/// a style choice: a card has to travel from the middle of the screen to the corner,
/// which a layout container cannot express. Its position is a screen rect that
/// animates; the VStack holds only the launcher.
struct OverlayContent: View {
    @ObservedObject var model: PromptModel
    let layout: Layout

    /// The panel's own frame. Changes when the launcher opens or closes, and the
    /// conversion below follows it in the same update so nothing moves visually.
    private var panelFrame: CGRect { model.panelFrame }

    var body: some View {
        ZStack(alignment: .topLeading) {
            if model.launcherVisible {
                PromptView(model: model)
                    // Fixed box, content pinned to its top edge: the confirmation
                    // card grows downwards instead of shifting the prompt.
                    .frame(
                        width: Layout.launcherSize.width,
                        height: Layout.launcherSize.height,
                        alignment: .topLeading
                    )
                    .place(layout.launcher, in: panelFrame)
                    .transition(.opacity)
            }

            ForEach(model.runs) { run in
                RunCard(run: run, compact: run.presentation == .badge)
                    .frame(width: size(for: run).width, height: size(for: run).height, alignment: .topLeading)
                    .place(rect(for: run), in: panelFrame)
                    .onTapGesture { model.bringToFront(run) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // One spring for every card's position and size at once, which is what makes
        // a card look like it travelled rather than like it was replaced.
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: signature)
    }

    /// What the animation should react to: which run is where, and how many badges
    /// there are. Output changing must NOT restart it.
    private var signature: String {
        model.runs.map { "\($0.id)\($0.presentation)" }.joined() + "\(model.launcherVisible)"
    }

    private func rect(for run: Run) -> CGRect {
        guard run.presentation == .badge else { return layout.card }
        let index = model.badges.firstIndex { $0 === run } ?? 0
        return layout.badge(index)
    }

    private func size(for run: Run) -> CGSize {
        run.presentation == .badge ? Layout.badgeSize : Layout.cardSize
    }
}

private extension View {
    /// Places a view at a screen rect, given the panel it lives in.
    ///
    /// The y flip is the whole reason this exists: SwiftUI counts down from the top
    /// of the panel, AppKit counts up from the bottom of the screen.
    func place(_ rect: CGRect, in panel: CGRect) -> some View {
        position(
            x: rect.midX - panel.minX,
            y: panel.maxY - rect.midY
        )
    }
}
