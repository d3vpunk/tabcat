import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import lockfile from 'proper-lockfile';
import { HANDLE_PATTERN, MagicName } from './names.js';

export function defaultNamesFile(): string {
  return `${homedir()}/.config/tabcat/names.jsonl`;
}

/** names.jsonl lives next to the history file — same directory, fixed sibling name. */
export function namesFileFor(historyFile: string): string {
  return join(dirname(historyFile), 'names.jsonl');
}

/**
 * Shape guard for one names.jsonl record. An empty `name` is a valid
 * tombstone (deletion marker); any other name must match the handle pattern.
 */
export function isMagicName(value: unknown): value is MagicName {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['name'] === 'string' &&
    (v['name'] === '' || HANDLE_PATTERN.test(v['name'])) &&
    typeof v['line'] === 'string' &&
    v['line'].trim() !== '' &&
    Array.isArray(v['cwds']) &&
    v['cwds'].every((cwd) => typeof cwd === 'string') &&
    typeof v['ts'] === 'number' &&
    Number.isFinite(v['ts'])
  );
}

/**
 * Reads names.jsonl: broken lines are skipped silently, last record per
 * command line wins, and a line whose latest record is a tombstone
 * (empty `name`) is dropped. Append-only — deletion never rewrites the file.
 */
export function readNames(file: string): MagicName[] {
  if (!existsSync(file)) return [];
  const byLine = new Map<string, MagicName>();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isMagicName(parsed)) byLine.set(parsed.line, parsed);
    } catch {
      // skip broken line
    }
  }
  return [...byLine.values()].filter((name) => name.name !== '');
}

/**
 * Best-effort append with a lightweight lockfile: a busy lock or any I/O error
 * never throws into the caller. Returns whether the record reached the file —
 * a caller that mirrors names in memory must not claim success for a write that
 * silently did nothing.
 */
export function appendName(file: string, name: MagicName): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const release = tryLock(file);
    if (release === null) return false;
    try {
      appendFileSync(file, `${JSON.stringify(name)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(file, 0o600);
      return true;
    } finally {
      release();
    }
  } catch {
    return false;
  }
}

function tryLock(file: string): (() => void) | null {
  try {
    return lockfile.lockSync(file, { realpath: false, stale: 30_000 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') return null;
    throw error;
  }
}
