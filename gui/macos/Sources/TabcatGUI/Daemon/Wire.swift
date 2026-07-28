import Foundation

/// The TSV wire format, mirrored from `src/daemon/protocol.ts`. Kept deliberately
/// small and dependency-free: this is the third implementation of the same four
/// escapes after the TypeScript and the zsh plugin, so it has to be boring.
enum Wire {
    /// Bumped only on incompatible changes. The daemon rejects anything else with
    /// `bad_protocol`, and this client disables itself rather than misrender.
    static let protocolVersion = 1

    /// Escapes the four characters that would otherwise break framing. Backslash
    /// first: doing it last would re-escape the backslashes just introduced.
    static func escape(_ value: String) -> String {
        var out = ""
        out.reserveCapacity(value.count)
        for character in value {
            switch character {
            case "\\": out += "\\\\"
            case "\t": out += "\\t"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            default: out.append(character)
            }
        }
        return out
    }

    /// Single left-to-right pass. A chain of replacements would turn the escaped
    /// form of a literal backslash-t into a real tab.
    static func unescape(_ value: String) -> String {
        guard value.contains("\\") else { return value }
        var out = ""
        var iterator = value.makeIterator()
        while let character = iterator.next() {
            guard character == "\\" else {
                out.append(character)
                continue
            }
            switch iterator.next() {
            case "t": out.append("\t")
            case "n": out.append("\n")
            case "r": out.append("\r")
            case "\\": out.append("\\")
            case let other?: out.append("\\"); out.append(other)
            case nil: out.append("\\")
            }
        }
        return out
    }

    /// One request per line: op, id, protocol, then the op's own fields.
    static func request(op: String, id: String, fields: [String]) -> String {
        let all = [op, id, String(protocolVersion)] + fields.map(escape)
        return all.joined(separator: "\t") + "\n"
    }

    /// A response block is lines until an empty one. Fields come back unescaped.
    static func rows(from block: String) -> [[String]] {
        block
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.split(separator: "\t", omittingEmptySubsequences: false).map { unescape(String($0)) } }
    }
}

/// A daemon error reply: `err <id> <code> <message>`.
struct DaemonError: Error {
    let code: String
    let message: String

    /// The daemon speaks a protocol this build does not — the one error that has
    /// to disable the client instead of being retried.
    var isProtocolMismatch: Bool { code == "bad_protocol" }
    /// Normal right after a cold start; the caller stays quiet and tries later.
    var isWarming: Bool { code == "warming" }
}

enum ClientError: Error {
    case notConnected
    case timedOut
    case socketPathUnavailable(String)
    case desynced
}
