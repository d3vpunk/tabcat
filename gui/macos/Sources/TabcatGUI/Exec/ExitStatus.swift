import Foundation

/// Turns whatever SwiftTerm reports into the exit code a shell would print.
///
/// Necessary because `LocalProcess` has two termination paths with different
/// meanings for the same parameter: one hands over the raw `waitpid` status
/// (`LocalProcess.swift:369`), the other an already-decoded code from
/// `.exited(let code)` (`:471`). `exit 3` arriving as 768 is the first shape —
/// 3 << 8 — and it would have been stored verbatim, because the daemon's `learn`
/// accepts anything up to 4096.
enum ExitStatus {
    /// - Parameter reported: the value from `processTerminated(source:exitCode:)`.
    static func normalise(_ reported: Int32) -> Int32 {
        // Small values come from the decoded path and are already what we want. A raw
        // status of 3 would mean "killed by SIGQUIT" and is indistinguishable from a
        // plain exit code 3; the plain reading wins, because ordinary non-zero exits
        // are common and that signal is not, so guessing the other way would mangle
        // the frequent case to rescue the rare one.
        guard reported > 0xFF else { return reported }

        let signal = reported & 0x7F
        if signal != 0 {
            // 128+signal is what every shell reports, and the daemon stores these
            // codes — so it has to match what zsh would have said.
            return 128 + signal
        }
        return (reported >> 8) & 0xFF
    }
}
