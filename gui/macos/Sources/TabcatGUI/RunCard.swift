import SwiftTerm
import SwiftUI

/// Hands out the run's terminal without ever creating a new one.
///
/// The view is deliberately dumb: SwiftUI may rebuild it at will, and a terminal
/// created here would restart the command each time.
struct TerminalPane: NSViewRepresentable {
    let terminal: LocalProcessTerminalView

    func makeNSView(context: Context) -> LocalProcessTerminalView { terminal }
    func updateNSView(_ view: LocalProcessTerminalView, context: Context) {}
}

/// One command, either in front with its output or shrunk to a badge in the rail.
///
/// Deliberately ONE view for both, not two that swap. A swap reads as a hard cut,
/// however it is animated — the same element changing size reads as a movement. What
/// differs is only how much of it is shown.
struct RunCard: View {
    @ObservedObject var run: Run
    let compact: Bool
    /// Closes this run. Terminates it first when it is still going — which is why
    /// the button says so rather than showing the same ✕ in both cases.
    let onClose: () -> Void

    @State private var hovering = false

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
        // The whole card takes the click, not only the glyphs that happen to be drawn
        // on it. Without this a tap landed only on the status dot and the command
        // text — padding, the spacer and the glass itself are not hit-testable, so
        // most of a badge was a hole.
        .contentShape(RoundedRectangle(cornerRadius: compact ? 18 : 22, style: .continuous))
        .onHover { hovering = $0 }
    }

    private var header: some View {
        HStack(spacing: 8) {
            statusDot
            title
                .font(Typeface.small(compact ? 11 : 12))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 6)
            if case let .finished(code) = run.state, code != 0 {
                // Built as a String first, and not interpolated into the Text: `code`
                // is optional, so the direct form rendered a failure as
                // "exit Optional(1)" — and an unreported one as "exit nil", since
                // `nil != 0` is true.
                Text(code.map { "exit \($0)" } ?? "exit unknown")
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
            }
            closeButton
        }
    }

    /// The badge says what the command is called, the card in front says what it is.
    ///
    /// A badge is 300 pt wide, so anything longer than about forty characters ends in an
    /// ellipsis — and `docker compose -f qlico/docker-compose.yaml run php vendor/bin/…`
    /// truncates to the part every one of those runs has in common. Its handle is the
    /// name the user gave it precisely because it is the short way to say which one it
    /// is, so where there is one it wins the badge.
    ///
    /// In front it stays the command: there is room for it, the terminal underneath is
    /// showing that command's output, and the expansion is what a handle is for.
    /// ⚡ and purple are the same marks the candidate list uses for a handle.
    @ViewBuilder private var title: some View {
        if compact, !run.handle.isEmpty {
            Text("⚡\(run.handle)")
                .foregroundStyle(.purple)
        } else {
            Text(run.command)
        }
    }

    /// The only way to get rid of a run by hand. Without it a failed badge stayed in
    /// the rail for good: a tap brings it to the front, and nothing else was bound.
    ///
    /// Shown on hover rather than always, so a full rail does not read as a row of
    /// buttons — but it occupies its space either way, so the header does not reflow
    /// under the pointer.
    private var closeButton: some View {
        Button(action: onClose) {
            Image(systemName: run.state == .running ? "stop.fill" : "xmark")
                .font(.system(size: 9, weight: .bold))
                .frame(width: 14, height: 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .opacity(hovering ? 1 : 0)
        .allowsHitTesting(hovering)
        .help(run.state == .running ? "stop and close" : "close")
        .accessibilityLabel(run.state == .running ? "Stop and close run" : "Close run")
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

    /// A real terminal, so cursor addressing, scroll regions and the alternate screen
    /// work — the hand-rolled line buffer this replaces already failed on an ordinary
    /// Symfony progress bar.
    ///
    /// Rendered only in front, never in the badge: an NSView inside a shrinking card
    /// would recompute its character grid on every animation frame, and the badge
    /// shows nothing but the command line anyway.
    private var output: some View {
        TerminalPane(terminal: run.terminal)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
