import SwiftUI

/// A command held back until it is confirmed.
///
/// Deliberately loud: red tint, the command spelled out in full, and every reason
/// listed. In a terminal the scrollback is the safety net — you can read afterwards
/// what you did. Here there is none, so the only chance to notice is before.
struct ConfirmCard: View {
    let pending: PromptModel.PendingRun

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
                Text("run this?")
                    .font(.system(size: 11, weight: .semibold))
                Spacer(minLength: 8)
                Text("⌘⏎ run   esc drop")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }

            // Wrapped, not truncated: the dangerous part of a long command is
            // frequently at its end.
            Text(pending.command)
                .font(Typeface.small(12))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                ForEach(pending.hazards, id: \.consequence) { hazard in
                    Text("· \(hazard.consequence)")
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                }
            }

            Text("in \(pending.cwd)")
                .font(Typeface.small(10))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.head)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(.orange.opacity(0.22)), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
