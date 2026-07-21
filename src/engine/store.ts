import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import lockfile from 'proper-lockfile';
import { HistoryEntry } from './model.js';

/**
 * Upper bound of learned entries. The predictor learns EVERY entry at startup
 * (O(entries × chunks × maxContext)) — without the cap, the append-only file
 * would make REPL startup ever slower over the years.
 * 20k entries ≈ months of usage; older ones barely carry any ranking mass
 * due to frecency decay anyway.
 */
export const MAX_HISTORY_ENTRIES = 20_000;
const LOCK_OPTIONS = { realpath: false, stale: 30_000 } as const;
const LOCK_RETRY_MS = 10;

export function defaultHistoryFile(): string {
  return `${homedir()}/.config/tabcat/history.jsonl`;
}

/** Reads history.jsonl; broken lines are counted instead of aborting startup. */
export function readHistory(file: string, onSkipped?: (count: number) => void): HistoryEntry[] {
  if (!existsSync(file)) return [];
  const entries: HistoryEntry[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isHistoryEntry(parsed)) entries.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) onSkipped?.(skipped);
  return entries;
}

export function appendHistory(file: string, entry: HistoryEntry): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) chmodSync(file, 0o600);
  const release = acquireLock(file, 2_000);
  if (!release) throw new Error(`Could not acquire history lock: ${file}`);
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(file, 0o600);
  } finally {
    release();
  }
}

/**
 * Reads the history and, when the cap is exceeded, compacts it to the most
 * recent `max` entries (atomic: tempfile + rename — a crash midway leaves
 * no half-written file). Corrupt lines are dropped in the process.
 * Below the cap: pure reading, no write access.
 */
export function compactHistory(
  file: string,
  max: number = MAX_HISTORY_ENTRIES,
  onSkipped?: (count: number) => void,
): HistoryEntry[] {
  const entries = readHistory(file, onSkipped);
  if (entries.length <= max) return entries;

  let release: (() => void) | undefined;
  try {
    release = acquireLock(file, 0) ?? undefined;
    if (!release) return entries;
  } catch (error) {
    if (isLockBusy(error)) return entries;
    throw error;
  }
  try {
    // Re-read after locking: between the first read and the lock, another
    // process may have appended entries or compacted itself.
    const current = readHistory(file);
    if (current.length <= max) return current;

    const kept = current.slice(-max);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
    return kept;
  } finally {
    release();
  }
}

function acquireLock(file: string, waitMs: number): (() => void) | null {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return lockfile.lockSync(file, LOCK_OPTIONS);
    } catch (error) {
      if (!isLockBusy(error)) throw error;
      if (Date.now() >= deadline) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
}

function isLockBusy(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ELOCKED';
}

/**
 * Stable identity of an entry. \u0001 as separator: never occurs in
 * cwd/command lines (a space would be ambiguous: "1 /a b c" = cwd '/a b' + 'c'
 * or cwd '/a' + 'b c').
 */
export const entryKey = (e: HistoryEntry): string => `${e.ts}${e.line}`;

/**
 * Which incoming entries are genuinely new versus the existing history.
 *
 * Entries with a real timestamp dedupe on (ts, line): the SAME command run at
 * two different times are two legitimate occurrences and both survive.
 *
 * Entries WITHOUT a real timestamp were stamped with `fallbackTs` by the
 * parser (plain history — no EXTENDED_HISTORY / HISTTIMEFORMAT). `fallbackTs`
 * is chosen fresh per import run, so (ts, line) would never match across runs
 * and re-imports would pile up duplicates. Those dedupe on the line alone —
 * making re-imports idempotent, as documented.
 */
export function dedupeImportEntries(
  existing: readonly HistoryEntry[],
  incoming: readonly HistoryEntry[],
  fallbackTs: number,
): HistoryEntry[] {
  const seenKeys = new Set(existing.map(entryKey));
  const seenLines = new Set(existing.map((e) => e.line));
  const fresh: HistoryEntry[] = [];
  for (const entry of incoming) {
    const synthesized = entry.ts === fallbackTs; // parser had no real timestamp
    if (synthesized ? seenLines.has(entry.line) : seenKeys.has(entryKey(entry))) continue;
    seenKeys.add(entryKey(entry));
    seenLines.add(entry.line);
    fresh.push(entry);
  }
  return fresh;
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['ts'] === 'number' &&
    (typeof v['cwd'] === 'string' || v['cwd'] === null) &&
    typeof v['line'] === 'string' &&
    (v['completion'] === undefined || isCompletionTelemetry(v['completion']))
  );
}

function isCompletionTelemetry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const telemetry = value as Record<string, unknown>;
  return ['attempts', 'accepts', 'top1Accepts', 'acceptedChars', 'undos', 'durationMs']
    .every((key) => typeof telemetry[key] === 'number' && Number.isFinite(telemetry[key]) && telemetry[key] >= 0);
}
