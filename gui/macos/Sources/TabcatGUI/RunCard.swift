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
    /// Runs the same command again. Only offered once the run has finished — on a
    /// running one "again" has two readings, and neither is worth a button.
    let onRerun: () -> Void

    @State private var hovering = false

    /// The status dot gets a column of its own so the line under it can line up with the
    /// command rather than with the dot. A fixed width is what makes that arithmetic
    /// rather than a guess — the glyph changes with the state and would otherwise move
    /// the text under it.
    private static let dotColumn: CGFloat = 10
    private static let headerSpacing: CGFloat = 8

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 8) {
            header
            if compact {
                // The badge's second line was empty, and where a command runs is the
                // other half of which run this is: two `⚡pest` badges are the same
                // shortcut in two projects. Muted, because it is context and not the
                // thing itself.
                //
                // It fits by arithmetic, not by hope: 28 pt of padding plus a 13 pt line
                // at Menlo 11, this spacing, and the reload button's 12 pt row comes to
                // 56 of the badge's 56 exactly (line heights measured, not assumed) —
                // which is why that button is 12 pt here and not the 14 the front card
                // uses. Anything larger needs a taller `Layout.badgeSize`: the card
                // anchors its content to the top, so what does not fit is clipped away
                // silently.
                HStack(spacing: Self.headerSpacing) {
                    Text(PathLabel.trail(of: run.cwd))
                        .font(Typeface.small(9))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        // From the front: a path that still does not fit loses the part
                        // furthest from what it identifies.
                        .truncationMode(.head)
                        // Lined up with the command above rather than with the status dot,
                        // so the two lines read as one block. Derived from the dot's column
                        // and the header's spacing instead of measured off a screenshot.
                        .padding(.leading, Self.dotColumn + Self.headerSpacing)
                    Spacer(minLength: 6)
                    // Under the ✕, which is where the pointer already is when the badge
                    // is being tidied — and a full row apart from it, because the two
                    // buttons mean opposite things.
                    rerunButton
                }
            } else {
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
        HStack(spacing: Self.headerSpacing) {
            statusDot
                .frame(width: Self.dotColumn)
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
            // In front the reload sits beside the ✕; the badge puts it on its own
            // row instead, where the header has no room to spare.
            if !compact { rerunButton }
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

    /// The same command, in the same directory, one click. It does not start it
    /// directly — the model rescans and holds a hazardous command back for ⌘Enter,
    /// exactly as if it had been typed.
    ///
    /// Shown on hover like the ✕ and only once the run has finished, but its space is
    /// held in every state — so neither the pointer arriving nor the run ending
    /// reflows the row under the pointer.
    private var rerunButton: some View {
        Button(action: onRerun) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 9, weight: .bold))
                // 12 pt in the badge, where the arithmetic above spends the last
                // point of height; 14 in front, matching the ✕.
                .frame(width: 14, height: compact ? 12 : 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .opacity(rerunOffered && hovering ? 1 : 0)
        .allowsHitTesting(rerunOffered && hovering)
        .help(compact ? "run again" : "run again (⌘R)")
        .accessibilityLabel("Run again")
    }

    private var rerunOffered: Bool { run.state != .running }

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
