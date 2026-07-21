import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryEntry } from '../../src/engine/model.js';
import { appendHistory, compactHistory, dedupeImportEntries, readHistory } from '../../src/engine/store.js';

const entry = (n: number): HistoryEntry => ({ ts: n, cwd: '/x', line: `cmd-${n}` });

describe('store: dedupeImportEntries', () => {
  const line = (ts: number, text: string): HistoryEntry => ({ ts, cwd: null, line: text });

  it('fallback (plain-history) re-import is idempotent across runs', () => {
    // First import: parser stamped every line with fallbackTs = 100.
    const first = dedupeImportEntries([], [line(100, 'git status'), line(100, 'npm test')], 100);
    expect(first.map((e) => e.line)).toEqual(['git status', 'npm test']);

    // Second import days later: fresh fallbackTs = 500, same commands.
    // Line-only dedup keeps it idempotent despite the changed timestamp.
    const second = dedupeImportEntries(first, [line(500, 'git status'), line(500, 'npm test')], 500);
    expect(second).toEqual([]);
  });

  it('keeps genuinely new fallback lines on re-import', () => {
    const existing = [line(100, 'git status')];
    const fresh = dedupeImportEntries(existing, [line(500, 'git status'), line(500, 'git push')], 500);
    expect(fresh.map((e) => e.line)).toEqual(['git push']);
  });

  it('timestamped entries: same command at different times both survive', () => {
    const fresh = dedupeImportEntries([], [line(1000, 'ls'), line(2000, 'ls')], 999);
    expect(fresh.map((e) => e.ts)).toEqual([1000, 2000]);
  });

  it('timestamped entry deduped against identical existing (ts, line)', () => {
    const fresh = dedupeImportEntries([line(1000, 'ls')], [line(1000, 'ls'), line(2000, 'ls')], 999);
    expect(fresh.map((e) => e.ts)).toEqual([2000]);
  });

  it('within-source fallback duplicates collapse to one', () => {
    const fresh = dedupeImportEntries([], [line(100, 'ls'), line(100, 'ls')], 100);
    expect(fresh).toHaveLength(1);
  });
});

describe('store: compactHistory', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tabcat-store-'));
    file = join(dir, 'history.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('below the cap: pure read, no rewrite', () => {
    for (const n of [1, 2, 3]) appendHistory(file, entry(n));
    const before = readFileSync(file, 'utf8');

    const entries = compactHistory(file, 10);

    expect(entries.map((e) => e.line)).toEqual(['cmd-1', 'cmd-2', 'cmd-3']);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('creates history directory and file privately and hardens existing permissions', () => {
    const privateDir = join(dir, 'config', 'tabcat');
    const privateFile = join(privateDir, 'history.jsonl');
    appendHistory(privateFile, entry(1));

    expect(statSync(privateDir).mode & 0o777).toBe(0o700);
    expect(statSync(privateFile).mode & 0o777).toBe(0o600);

    chmodSync(privateFile, 0o644);
    appendHistory(privateFile, entry(2));
    expect(statSync(privateFile).mode & 0o777).toBe(0o600);
  });

  it('above the cap: keeps the most recent N and compacts the file', () => {
    for (let n = 1; n <= 5; n++) appendHistory(file, entry(n));

    const entries = compactHistory(file, 3);

    expect(entries.map((e) => e.line)).toEqual(['cmd-3', 'cmd-4', 'cmd-5']);
    // File truly compacted: reading again yields only the remainder.
    expect(readHistory(file).map((e) => e.line)).toEqual(['cmd-3', 'cmd-4', 'cmd-5']);
  });

  it('sets private permissions after compaction', () => {
    for (let n = 1; n <= 4; n++) appendHistory(file, entry(n));
    chmodSync(file, 0o644);

    compactHistory(file, 2);

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('compaction also removes corrupt lines', () => {
    for (const n of [1, 2, 3, 4]) appendHistory(file, entry(n));
    appendHistory(file, entry(5));
    writeFileSync(file, readFileSync(file, 'utf8') + 'NOT-JSON\n', 'utf8');

    const entries = compactHistory(file, 3);

    expect(entries.map((e) => e.line)).toEqual(['cmd-3', 'cmd-4', 'cmd-5']);
  });

  it('reports the number of skipped history lines once', () => {
    appendHistory(file, entry(1));
    writeFileSync(file, `${readFileSync(file, 'utf8')}NOT-JSON\n{}\n`, 'utf8');
    const warnings: number[] = [];

    const entries = readHistory(file, (count) => warnings.push(count));

    expect(entries.map((e) => e.line)).toEqual(['cmd-1']);
    expect(warnings).toEqual([2]);
  });

  it('reads valid completion telemetry and discards invalid', () => {
    appendHistory(file, {
      ...entry(1),
      completion: { attempts: 2, accepts: 1, top1Accepts: 1, acceptedChars: 8, undos: 0, durationMs: 1200 },
    });
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ ...entry(2), completion: { attempts: 'x' } })}\n`, 'utf8');
    const skipped: number[] = [];

    const entries = readHistory(file, (count) => skipped.push(count));

    expect(entries[0]?.completion?.acceptedChars).toBe(8);
    expect(skipped).toEqual([1]);
  });

  it('no tempfile leftover after compaction', () => {
    for (let n = 1; n <= 4; n++) appendHistory(file, entry(n));
    compactHistory(file, 2);

    const leftover = readHistory(`${file}.tmp-${process.pid}`);
    expect(leftover).toEqual([]);
  });

  it('skips rewrite on concurrent writer instead of losing entries', () => {
    for (let n = 1; n <= 5; n++) appendHistory(file, entry(n));
    mkdirSync(`${file}.lock`);

    const entries = compactHistory(file, 3);

    expect(entries.map((e) => e.line)).toEqual(['cmd-1', 'cmd-2', 'cmd-3', 'cmd-4', 'cmd-5']);
    expect(readHistory(file).map((e) => e.line)).toEqual(['cmd-1', 'cmd-2', 'cmd-3', 'cmd-4', 'cmd-5']);
  });

  it('removes lock after successful compaction', () => {
    for (let n = 1; n <= 4; n++) appendHistory(file, entry(n));
    compactHistory(file, 2);

    expect(() => mkdirSync(`${file}.lock`)).not.toThrow();
  });
});
