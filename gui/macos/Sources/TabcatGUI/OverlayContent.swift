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

    /// The panel's own frame. Changes when the launcher opens or closes, and the
    /// conversion below follows it in the same update so nothing moves visually.
    private var panelFrame: CGRect { model.panelFrame }
    /// Read from the model, not held: it is recomputed for whichever screen the
    /// overlay is opening on.
    private var layout: Layout { model.layout }

    var body: some View {
        ZStack(alignment: .topLeading) {
            if model.launcherVisible {
                PromptView(model: model)
                    // Fixed box, content pinned to its top edge: the confirmation
                    // card grows downwards instead of shifting the prompt.
                    .frame(
                        width: layout.launcherSize.width,
                        height: layout.launcherSize.height,
                        alignment: .topLeading
                    )
                    .place(layout.launcher, in: panelFrame)
                    .transition(.opacity)
            }

            ForEach(model.runs) { run in
                let rect = rect(for: run)
                RunCard(
                    run: run,
                    compact: model.presentation(of: run) == .badge,
                    onClose: { model.dismiss(run) }
                )
                // Size taken from the same rect as the position, so a card that had
                // to shrink to fit the screen is also drawn at that size.
                .frame(width: rect.width, height: rect.height, alignment: .topLeading)
                .place(rect, in: panelFrame)
                .onTapGesture { model.bringToFront(run) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // One spring for every card's position and size at once, which is what makes
        // a card look like it travelled rather than like it was replaced.
        //
        // Its settling time is what the Controller's shrink delay has to outlast: a
        // panel that shrinks to the rail while a card is still flying towards it
        // clips the card. Slower or less damped here means a longer wait there.
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: signature)
    }

    /// What the animation should react to: which run is where, and how many badges
    /// there are. Output changing must NOT restart it.
    private var signature: String {
        model.runs.map { "\($0.id)\(model.presentation(of: $0))" }.joined()
            + "\(model.launcherVisible)"
            // So a confirmation card appearing slides the run card down instead of
            // teleporting it.
            + "\(Int(model.launcherHeight))"
        // Deliberately NOT the layout: a display that went away should reposition
        // everything at once, not send the cards gliding across the new screen.
    }

    private func rect(for run: Run) -> CGRect {
        guard model.presentation(of: run) == .badge else {
            // The last measured height survives the launcher being hidden, so the
            // card stays where it was instead of jumping when the launcher goes away.
            return layout.card(below: model.launcherHeight)
        }
        let index = model.badges.firstIndex { $0 === run } ?? 0
        return layout.badge(index)
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
