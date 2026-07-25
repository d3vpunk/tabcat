import Foundation

/// Turns a PTY byte stream into lines a text view can show.
///
/// This is not a terminal emulator and does not pretend to be one. It handles what
/// non-interactive commands actually do: newlines, carriage returns, and the handful
/// of cursor sequences a progress bar redraws itself with. Colours are stripped so
/// they do not appear as `[32m`.
///
/// The progress-bar handling is not optional decoration. Symfony Console — and with
/// it every `ecs`, `phpstan` or `composer` run — does not use a carriage return; it
/// moves the cursor up and erases the line. Stripping those as if they were colour
/// codes made each redraw append instead of overwrite, so a single bar arrived as a
/// dozen bars side by side.
///
/// What is still missing is absolute cursor positioning and scroll regions, so a
/// full-screen program (`vim`, `git rebase -i`) renders wrong. That is what a real
/// emulator would be for.
struct OutputBuffer {
    /// Bounded so a runaway command cannot grow the view without limit.
    static let maxLines = 500

    private(set) var lines: [String] = []
    private var current = ""
    /// Set while an escape sequence is being consumed across chunk boundaries — a
    /// sequence can be split by the read that delivered it.
    private var escape: EscapeState = .none
    /// Parameter bytes of the CSI sequence being read, for the same reason.
    private var parameters = ""

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
                case "[":
                    escape = .csi
                    parameters = ""
                case "]": escape = .osc
                // A two-character sequence such as `ESC =`; nothing else to consume.
                default: escape = .none
                }
                continue
            case .csi:
                // Parameters and intermediates are 0x20...0x3F, the final byte is
                // 0x40...0x7E.
                if let ascii = character.asciiValue, (0x40...0x7E).contains(ascii) {
                    apply(final: character, parameters: parameters)
                    parameters = ""
                    escape = .none
                } else {
                    parameters.append(character)
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

    /// The CSI sequences that move or erase. Everything else — colours, bold, cursor
    /// visibility — is dropped, which is the right outcome for a plain text view.
    private mutating func apply(final: Character, parameters: String) {
        let first = Int(parameters.split(separator: ";").first.map(String.init) ?? "") ?? 0
        switch final {
        case "K":
            // Erase in line. All three variants end up clearing what a progress bar
            // is about to rewrite.
            current = ""
        case "G":
            // Cursor to a column. Only column 1 matters in practice, and that is a
            // carriage return by another name.
            current = ""
        case "A":
            // Cursor up. Taking the lines away is an approximation — the erase that
            // follows in every real progress bar would have emptied them anyway, and
            // keeping them would leave one stale bar per redraw on screen.
            let count = max(1, first)
            lines.removeLast(min(count, lines.count))
            current = ""
        case "J" where first == 2:
            lines.removeAll()
            current = ""
        default:
            break
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
