import Foundation

/// One row of `settings list` — the schema travelling over the wire. The daemon
/// (src/settings/schema.ts) is the single source of truth: this client renders
/// whatever arrives instead of compiling its own copy of the schema, so a new
/// setting appears in the gear panel without touching Swift. Only the two
/// boot-path keys are duplicated, in `BootSettings`.
struct SettingRow: Identifiable, Equatable {
    let key: String
    let type: String
    let value: String
    let defaultValue: String
    let constraint: String
    let label: String
    /// The schema's description. Not `description` — that name belongs to
    /// CustomStringConvertible and shadowing it invites confusing prints.
    let details: String
    /// false: takes effect at the next start — the panel says so.
    let appliesLive: Bool
    /// Whether the value comes from the file; only then is there a reset.
    let overridden: Bool
    /// What one stepper click changes on an int row.
    let step: Int

    var id: String { key }

    /// `700..2400` from the wire, for the stepper's bounds.
    var range: ClosedRange<Int>? {
        let parts = constraint.components(separatedBy: "..")
        guard parts.count == 2, let low = Int(parts[0]), let high = Int(parts[1]), low <= high else { return nil }
        return low...high
    }

    /// The options of an enum row, `a|b|c` on the wire.
    var options: [String] {
        constraint.isEmpty ? [] : constraint.components(separatedBy: "|")
    }
}

extension DaemonClient {
    /// `settings list` — every known setting with type, value, default,
    /// constraint and texts. Answers even while the daemon is warming: the op
    /// never touches the predictor.
    func settingsList() async throws -> [SettingRow] {
        let rows = try await request(op: "settings", fields: ["list", "", ""])
        return rows.dropFirst().compactMap { row -> SettingRow? in
            guard row.count >= 9 else { return nil }
            return SettingRow(
                key: row[0],
                type: row[1],
                value: row[2],
                defaultValue: row[3],
                constraint: row[4],
                label: row[5],
                details: row[6],
                appliesLive: row[7] == "1",
                overridden: row[8] == "1",
                // A daemon one release older sends nine fields; a missing step
                // degrades to single stepping rather than to a dropped row.
                step: row.count > 9 ? max(1, Int(row[9]) ?? 1) : 1
            )
        }
    }

    /// `settings set` — validated daemon-side against the same schema the CLI
    /// and the REPL use. Returns the effective value.
    func settingsSet(key: String, value: String) async throws -> String {
        let rows = try await request(op: "settings", fields: ["set", key, value])
        return rows[0].count > 2 ? rows[0][2] : value
    }

    /// `settings reset` — removes the override; the default applies again.
    /// Returns the default.
    func settingsReset(key: String) async throws -> String {
        let rows = try await request(op: "settings", fields: ["reset", key, ""])
        return rows[0].count > 2 ? rows[0][2] : ""
    }
}
