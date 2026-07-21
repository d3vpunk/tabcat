import { HistoryEntry } from './model.js';

/**
 * Parses ~/.zsh_history (seed import).
 *
 * Extended format (EXTENDED_HISTORY): ": <epoch>:<duration>;<command>" —
 * the timestamp is adopted. zsh writes multiline commands with real
 * newlines into ONE entry: as soon as the file contains extended entries,
 * every line WITHOUT a prefix belongs to the previous one (multiline
 * continuation) — otherwise half commands would poison the model as
 * separate history entries.
 *
 * Pure plain files: each line is a command stamped with fallbackTs (dated
 * old so it does not dominate the frecency ranking). Multiline is not
 * detectable there.
 */
export function parseZshHistory(content: string, cwd: string | null, fallbackTs: number): HistoryEntry[] {
  const extended = /^: (\d+):\d+;(.*)$/;
  const lines = content.split('\n').filter((line) => line.trim() !== '');

  if (!lines.some((line) => extended.test(line))) {
    return lines.map((line) => ({ ts: fallbackTs, cwd, line }));
  }

  const entries: HistoryEntry[] = [];
  for (const rawLine of lines) {
    const match = extended.exec(rawLine);
    if (match) {
      const [, epoch, command] = match;
      if (epoch === undefined || command === undefined || command.trim() === '') continue;
      entries.push({ ts: Number(epoch) * 1000, cwd, line: command });
    } else if (entries.length > 0) {
      // Continuation line of a multiline command.
      const last = entries[entries.length - 1] as HistoryEntry;
      last.line += `\n${rawLine}`;
    }
    // Plain lines BEFORE the first extended entry: not assignable -> dropped.
  }
  return entries;
}
