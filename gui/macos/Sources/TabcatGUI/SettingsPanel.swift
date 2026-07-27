import SwiftUI

/// The gear panel: every setting the daemon knows, rendered from the wire rows.
/// It swaps in where the candidate list stood — same glass, no second window,
/// no activation dance with the nonactivating panel. Escape closes it (the
/// topmost rung of the ladder while it is open).
///
/// One control per type, chosen by the row's `type` field, and all of them in
/// the launcher's own language — capsule glass like the chips, Menlo, tertiary
/// symbols — rather than stock AppKit controls that read as another program.
/// A type this build does not know falls back to the text field, so a newer
/// daemon's settings stay editable instead of invisible.
struct SettingsPanel: View {
    @ObservedObject var model: PromptModel

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text("settings")
                    .font(Typeface.small(9))
                    .foregroundStyle(.tertiary)
                Spacer()
                Text("esc closes · changes apply immediately")
                    .font(Typeface.small(9))
                    .foregroundStyle(.quaternary)
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 6)

            if model.settingRows.isEmpty {
                // The reason, not a guess: reloadSettings put the actual failure here.
                Text(model.settingsNote ?? "loading…")
                    .font(Typeface.small(11))
                    .foregroundStyle(.tertiary)
                    .padding(8)
            }

            ForEach(model.settingRows) { row in
                SettingRowView(
                    row: row,
                    onSet: { model.updateSetting(key: row.key, value: $0) },
                    onReset: { model.resetSetting(key: row.key) }
                )
            }
        }
    }
}

private struct SettingRowView: View {
    let row: SettingRow
    let onSet: (String) -> Void
    let onReset: () -> Void
    /// Buffer for the text-field types; committed on Enter, not per keystroke —
    /// half a hotkey is not a hotkey.
    @State private var draft = ""

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(row.label)
                        .font(Typeface.small(12))
                        .foregroundStyle(row.overridden ? .primary : .secondary)
                    if !row.appliesLive {
                        Text("next start")
                            .font(Typeface.small(9))
                            .foregroundStyle(.tertiary)
                    }
                }
                Text(row.details)
                    .font(Typeface.small(10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 16)
            control
            // Reset exists only where there is an override to remove — the same
            // rule as everywhere else: reset deletes the key, it does not write
            // the default. Kept in the layout either way so the controls line up
            // in one column instead of shifting with the override state.
            Button {
                onReset()
            } label: {
                Image(systemName: "arrow.uturn.backward")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
            .help("Reset to default (\(row.defaultValue))")
            .opacity(row.overridden ? 1 : 0)
            .disabled(!row.overridden)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .onAppear { draft = row.value }
        .onChange(of: row.value) { _, value in draft = value }
    }

    @ViewBuilder private var control: some View {
        switch row.type {
        case "bool":
            // The chips' own idiom: a capsule that is glass while on, hollow
            // while off — not a stock switch in system accent blue.
            Button { onSet(row.value == "true" ? "false" : "true") } label: {
                Text(row.value == "true" ? "on" : "off")
                    .font(Typeface.small(11))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 5)
                    .foregroundStyle(row.value == "true" ? .primary : .secondary)
            }
            .buttonStyle(.plain)
            .glassEffect(row.value == "true" ? .regular : .clear, in: Capsule())
            .contentShape(Capsule())

        case "int":
            HStack(spacing: 2) {
                step(by: -row.step, symbol: "minus", disabledAt: row.range?.lowerBound)
                Text(row.value)
                    .font(Typeface.small(12))
                    .monospacedDigit()
                    .frame(minWidth: 44)
                step(by: row.step, symbol: "plus", disabledAt: row.range?.upperBound)
            }
            .glassEffect(.clear, in: Capsule())

        case "enum":
            // The options are few by construction; showing them all beats a menu,
            // which would take key focus from a nonactivating panel.
            HStack(spacing: 2) {
                ForEach(row.options, id: \.self) { option in
                    Button { onSet(option) } label: {
                        Text(option)
                            .font(Typeface.small(11))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .foregroundStyle(option == row.value ? .primary : .secondary)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(option == row.value ? .regular : .clear, in: Capsule())
                }
            }

        default:
            // hotkey, string, and whatever a newer daemon invents.
            TextField(row.defaultValue, text: $draft)
                .textFieldStyle(.plain)
                .font(Typeface.small(12))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .frame(width: 150)
                .background(.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .onSubmit { onSet(draft) }
        }
    }

    private func step(by amount: Int, symbol: String, disabledAt bound: Int?) -> some View {
        let value = Int(row.value) ?? 0
        let atBound = bound != nil && value == bound
        return Button {
            // Clamped to the wire's range: a step from 2380 by 50 means "to the
            // top", not a bad_value round trip.
            let target = value + amount
            let clamped = row.range.map { Swift.min(Swift.max(target, $0.lowerBound), $0.upperBound) } ?? target
            onSet(String(clamped))
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(atBound ? 0.25 : 1)
        .disabled(atBound)
    }
}
