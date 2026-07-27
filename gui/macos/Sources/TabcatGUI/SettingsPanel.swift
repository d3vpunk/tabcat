import SwiftUI

/// The gear panel: every setting the daemon knows, rendered from the wire rows.
/// It swaps in where the candidate list stood — same glass, no second window,
/// no activation dance with the nonactivating panel. Escape closes it (the
/// topmost rung of the ladder while it is open).
///
/// One control per type, chosen by the row's `type` field: a type this build
/// does not know falls back to a text field, so a newer daemon's settings stay
/// editable instead of invisible.
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
            .padding(.bottom, 4)

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
        HStack(alignment: .firstTextBaseline, spacing: 10) {
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
            // the default.
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
        .padding(.vertical, 3)
        .onAppear { draft = row.value }
        .onChange(of: row.value) { _, value in draft = value }
    }

    @ViewBuilder private var control: some View {
        switch row.type {
        case "bool":
            Toggle("", isOn: Binding(
                get: { row.value == "true" },
                set: { onSet($0 ? "true" : "false") }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.mini)

        case "int":
            HStack(spacing: 6) {
                Text(row.value)
                    .font(Typeface.small(12))
                    .monospacedDigit()
                Stepper(
                    "",
                    value: Binding(
                        get: { Int(row.value) ?? 0 },
                        set: { onSet(String($0)) }
                    ),
                    in: row.range ?? Int.min...Int.max,
                    step: row.step
                )
                .labelsHidden()
                .controlSize(.mini)
            }

        case "enum":
            Picker("", selection: Binding(
                get: { row.value },
                set: { onSet($0) }
            )) {
                ForEach(row.options, id: \.self) { option in
                    Text(option).tag(option)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .controlSize(.small)
            .fixedSize()

        default:
            // hotkey, string, and whatever a newer daemon invents.
            TextField("", text: $draft)
                .textFieldStyle(.roundedBorder)
                .font(Typeface.small(11))
                .controlSize(.small)
                .frame(width: 140)
                .onSubmit { onSet(draft) }
        }
    }
}
