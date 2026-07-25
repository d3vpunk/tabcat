import SwiftUI

/// One command, either in front with its output or shrunk to a badge in the rail.
///
/// Deliberately ONE view for both, not two that swap. A swap reads as a hard cut,
/// however it is animated — the same element changing size reads as a movement. What
/// differs is only how much of it is shown.
struct RunCard: View {
    @ObservedObject var run: Run
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 0 : 8) {
            header
            if !compact {
                output
            }
        }
        .padding(compact ? 14 : 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Radius tracks the height, so shrinking keeps the Dock's proportion instead
        // of turning into a rectangle with rounded nubs. .continuous is the squircle;
        // the default .circular reads as a hard corner.
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: compact ? 18 : 22, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 8) {
            statusDot
            Text(run.command)
                .font(Typeface.small(compact ? 11 : 12))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 6)
            if case let .finished(code) = run.state, code != 0 {
                Text("exit \(code)")
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
            }
        }
    }

    private var statusDot: some View {
        Group {
            switch run.state {
            case .running:
                // Pulses, so a command producing no output still looks alive rather
                // than stuck — the only signal a badge in the corner can give.
                Image(systemName: "circle.fill")
                    .foregroundStyle(.yellow)
                    .symbolEffect(.pulse)
            case let .finished(code):
                Image(systemName: code == 0 ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(code == 0 ? .green : .red)
            }
        }
        .font(.system(size: 9))
    }

    private var output: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(run.output.isEmpty ? " " : run.output)
                    .font(Typeface.small(11))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .id("end")
            }
            // Fades at the edge instead of cutting text off mid-glyph.
            .scrollEdgeEffectStyle(.soft, for: .vertical)
            .onChange(of: run.output) {
                // Follow the tail: a command's last lines are the ones worth seeing,
                // and scrolling by hand while output streams is hopeless.
                proxy.scrollTo("end", anchor: .bottom)
            }
        }
    }
}
