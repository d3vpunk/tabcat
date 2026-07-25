import SwiftUI

/// The output of one command.
///
/// Its own glass surface rather than more text in the prompt card: this is the
/// thing that later shrinks into the corner and becomes a badge, so it has to be a
/// separate element from the start.
struct RunCard: View {
    @ObservedObject var run: Run

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            output
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 8) {
            statusDot
            Text(run.command)
                .font(Typeface.small(12))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
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
                // than stuck.
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
            .frame(maxHeight: 220)
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
