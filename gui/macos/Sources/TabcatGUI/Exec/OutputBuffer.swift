import Foundation

/// Turns a PTY byte stream into lines a text view can show.
///
/// This is not a terminal emulator and does not pretend to be one. It handles the
/// two things nearly every non-interactive command does — newlines, and carriage
/// returns to rewrite the current line — and strips escape sequences so colour
/// codes do not show up as `[32m`. That covers `npm test`, `git`, `docker` and
/// friends. It does not cover cursor addressing, so a full-screen program (vim,
/// `git rebase -i`) will look wrong; that is what a real emulator would be for.
struct OutputBuffer {
    /// Bounded so a runaway command cannot grow the view without limit.
    static let maxLines = 500

    private(set) var lines: [String] = []
    private var current = ""
    /// Set while an escape sequence is being consumed across chunk boundaries — a
    /// sequence can be split by the read that delivered it.
    private var escape: EscapeState = .none

    private enum EscapeState {
        case none
        /// Saw ESC, waiting for the sequence's introducer.
        case escaped
        /// Inside CSI (`ESC [`), consuming until a byte in 0x40...0x7E.
        case csi
        /// Inside OSC (`ESC ]`), consuming until BEL or ST.
        case osc
    }

    var text: String {
        (lines + (current.isEmpty ? [] : [current])).joined(separator: "\n")
    }

    mutating func append(_ chunk: String) {
        for character in chunk {
            switch escape {
            case .escaped:
                switch character {
                case "[": escape = .csi
                case "]": escape = .osc
                // A two-character sequence such as `ESC =`; nothing else to consume.
                default: escape = .none
                }
                continue
            case .csi:
                // Parameters and intermediates are 0x20...0x3F, the final byte is
                // 0x40...0x7E.
                if let ascii = character.asciiValue, (0x40...0x7E).contains(ascii) {
                    escape = .none
                }
                continue
            case .osc:
                // BEL terminates, and so does ST (`ESC \`) — treating a bare ESC as
                // the end is close enough, since the backslash then falls through as
                // ordinary text at worst.
                if character == "\u{07}" || character == "\u{1B}" {
                    escape = .none
                }
                continue
            case .none:
                break
            }

            switch character {
            case "\u{1B}":
                escape = .escaped
            case "\n":
                push()
            case "\r":
                // Rewrite the line rather than break it: this is how a progress bar
                // updates in place, and keeping it would print one line per tick.
                current = ""
            case "\u{08}":
                if !current.isEmpty { current.removeLast() }
            default:
                current.append(character)
            }
        }
    }

    /// Ends the stream, keeping whatever had no trailing newline.
    mutating func finish() {
        if !current.isEmpty { push() }
    }

    private mutating func push() {
        lines.append(current)
        current = ""
        if lines.count > Self.maxLines {
            lines.removeFirst(lines.count - Self.maxLines)
        }
    }
}
