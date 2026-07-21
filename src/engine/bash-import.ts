import { HistoryEntry } from './model.js';

/**
 * Parses ~/.bash_history (seed import).
 *
 * Without HISTTIMEFORMAT: each line is a command stamped with fallbackTs
 * (dated old so it does not dominate the frecency ranking). With
 * HISTTIMEFORMAT, each command is preceded by a line '#<epoch-seconds>' —
 * it provides the timestamp of the following line. Detection is strict
 * (9–11 digits) so real commands like '#42' are not swallowed as timestamps.
 *
 * Multiline (cmdhist/lithist) is not reconstructed — not reliably
 * distinguishable from subsequent commands in the file.
 */
export function parseBashHistory(content: string, cwd: string | null, fallbackTs: number): HistoryEntry[] {
  const timestamp = /^#(\d{9,11})$/;
  const entries: HistoryEntry[] = [];
  let pendingTs: number | null = null;

  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    const match = timestamp.exec(line);
    if (match && match[1] !== undefined) {
      pendingTs = Number(match[1]) * 1000;
      continue;
    }
    entries.push({ ts: pendingTs ?? fallbackTs, cwd, line });
    pendingTs = null;
  }
  return entries;
}
