import { appendFileSync, chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineHost } from '../../src/daemon/engine-host.js';
import { HistoryEntry } from '../../src/engine/model.js';
import { MagicName } from '../../src/engine/names.js';

const NO_FS = { readdir: () => null };

let dir: string;
let historyFile: string;
let namesFile: string;

const entry = (line: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  ts: 1_700_000_000_000,
  cwd: '/work',
  line,
  ...over,
});

const write = (entries: readonly HistoryEntry[]): void =>
  writeFileSync(historyFile, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

const append = (...entries: readonly HistoryEntry[]): void =>
  appendFileSync(historyFile, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

const host = (options: { magicNames?: boolean; maxEntries?: number } = {}): EngineHost => {
  const created = new EngineHost({
    historyFile,
    fs: NO_FS,
    homeDir: '/home/test',
    now: () => 1_700_000_100_000,
    ...options,
  });
  created.build();
  return created;
};

const inserts = (engine: EngineHost, line: string, cwd = '/work'): string[] =>
  engine.predict({ line, cursor: line.length, cwd }).candidates.map((c) => c.insert);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabcat-host-'));
  historyFile = join(dir, 'history.jsonl');
  namesFile = join(dir, 'names.jsonl');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('EngineHost: build and state', () => {
  it('is warming until build() ran', () => {
    write([entry('git status')]);
    const engine = new EngineHost({ historyFile, fs: NO_FS });
    expect(engine.state).toBe('warming');
    expect(() => engine.predict({ line: 'g', cursor: 1, cwd: '/work' })).toThrow(/warming/);
    engine.build();
    expect(engine.state).toBe('ready');
  });

  it('serves predictions from the learned history', () => {
    write([entry('git status'), entry('git status'), entry('npm run build')]);
    expect(inserts(host(), 'git ')).toContain('status');
  });

  it('starts empty when the history file does not exist', () => {
    const engine = host();
    expect(engine.stats().entries).toBe(0);
    expect(inserts(engine, 'g')).toEqual([]);
  });

  it('survives corrupt lines', () => {
    writeFileSync(historyFile, `${JSON.stringify(entry('git status'))}\nnot json\n{"ts":1}\n`);
    const warnings: string[] = [];
    const engine = new EngineHost({ historyFile, fs: NO_FS, onWarn: (m) => warnings.push(m) });
    engine.build();
    expect(engine.stats().entries).toBe(1);
    expect(warnings.join(' ')).toMatch(/skipped 2 invalid/);
  });
});

describe('EngineHost: tail follow', () => {
  it('learns lines another process appended, without a rebuild', () => {
    write([entry('git status')]);
    const engine = host();
    // Unrelated context still backfills candidates — assert on membership.
    expect(inserts(engine, 'npm ')).not.toContain('run build');

    append(entry('npm run build'));
    expect(inserts(engine, 'npm ')).toContain('run build');
    expect(engine.stats().entries).toBe(2);
  });

  it('ignores a half-written trailing line until its newline arrives', () => {
    write([entry('git status')]);
    const engine = host();
    const pending = JSON.stringify(entry('deploy production'));
    appendFileSync(historyFile, pending.slice(0, 20));
    expect(inserts(engine, 'deploy ')).not.toContain('production');
    expect(engine.stats().entries).toBe(1);

    appendFileSync(historyFile, `${pending.slice(20)}\n`);
    expect(inserts(engine, 'deploy ')).toContain('production');
    expect(engine.stats().entries).toBe(2);
  });

  it('handles a multi-byte character split across the read chunk boundary', () => {
    // The tail is read in 64 KiB chunks; a UTF-8 sequence straddling that
    // boundary must not decode to replacement characters. Pad so the 'ä' of
    // the second entry starts exactly at byte 65536.
    write([entry('git status')]);
    const engine = host();
    const tail = `${JSON.stringify(entry('echo ä-marker'))}\n`;
    const padded = entry(`pad ${'x'.repeat(4096)}`);
    const paddingLine = `${JSON.stringify(padded)}\n`;
    const currentSize = readFileSync(historyFile).length;
    const target = 64 * 1024;
    const beforeMarker = tail.indexOf('ä');
    let filler = '';
    while (currentSize + filler.length + beforeMarker < target) filler += paddingLine;
    const trim = currentSize + filler.length + beforeMarker - target;
    // Shrink the last padding line by `trim` characters of its command text.
    if (trim > 0) {
      filler = filler.slice(0, filler.length - paddingLine.length);
      const shortened = entry(`pad ${'x'.repeat(4096 - trim)}`);
      filler += `${JSON.stringify(shortened)}\n`;
    }
    appendFileSync(historyFile, filler + tail);
    expect(inserts(engine, 'echo ')).toContain('ä-marker');
  });

  it('rebuilds when another process compacted the file (inode changed)', () => {
    write([entry('git status'), entry('npm run build')]);
    const engine = host();
    expect(engine.stats().entries).toBe(2);

    // compactHistory writes a tempfile and renames it -> new inode, fewer entries.
    const replacement = join(dir, 'history.jsonl.tmp-foreign');
    writeFileSync(replacement, `${JSON.stringify(entry('cargo build'))}\n`);
    renameSync(replacement, historyFile);

    expect(engine.stats().entries).toBe(2); // stale until the next request
    expect(inserts(engine, 'cargo ')).toContain('build');
    expect(engine.stats().entries).toBe(1);
    expect(inserts(engine, 'npm ')).not.toContain('run build');
  });

  it('rebuilds when the file was truncated in place', () => {
    write([entry('git status'), entry('npm run build')]);
    const engine = host();
    writeFileSync(historyFile, `${JSON.stringify(entry('ls -la'))}\n`);
    expect(inserts(engine, 'ls ')).toContain('-la');
    expect(engine.stats().entries).toBe(1);
  });

  it('keeps serving when the history file disappears', () => {
    write([entry('git status')]);
    const engine = host();
    rmSync(historyFile);
    expect(inserts(engine, 'git ')).toContain('status');
  });
});

describe('EngineHost: learn', () => {
  it('appends and learns the entry exactly once', () => {
    const engine = host();
    expect(engine.learn(entry('git push'))).toEqual({ learned: true });
    expect(readFileSync(historyFile, 'utf8').trim().split('\n')).toHaveLength(1);
    // A second count would mean the own append was learned twice (offset bug).
    expect(engine.stats().entries).toBe(1);
    expect(inserts(engine, 'git ')).toContain('push');
  });

  it('does not skip a foreign line that landed before our own append', () => {
    const engine = host();
    append(entry('npm test'));
    engine.learn(entry('git push'));
    expect(engine.stats().entries).toBe(2);
    expect(inserts(engine, 'npm ')).toContain('test');
    expect(inserts(engine, 'git ')).toContain('push');
  });

  it('appends exit 126/127 but never predicts them (REPL parity)', () => {
    const engine = host();
    engine.learn(entry('nosuchcmd --x', { exitCode: 127 }));
    engine.learn(entry('notexec.sh', { exitCode: 126 }));
    engine.learn(entry('git status', { exitCode: 0 }));
    expect(readFileSync(historyFile, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(inserts(engine, 'nosuchcmd')).toEqual([]);
    expect(inserts(engine, 'notexec')).toEqual([]);
    expect(inserts(engine, 'git ')).toContain('status');
  });

  it('stores multiline commands but keeps them out of prediction', () => {
    const engine = host();
    engine.learn(entry('for f in *; do\n  echo $f\ndone'));
    expect(readFileSync(historyFile, 'utf8')).toContain('\\n');
    expect(inserts(engine, 'for ')).toEqual([]);
  });

  it('reports a read-only history once and stops retrying', () => {
    write([entry('git status')]);
    const engine = host();
    chmodSync(dir, 0o500);
    try {
      const first = engine.learn(entry('git push'));
      expect(first.learned).toBe(false);
      expect(first.error).toBeTruthy();
      expect(engine.stats().historyWritable).toBe(false);
      expect(engine.learn(entry('git pull')).error).toMatch(/not writable/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('EngineHost: magic names', () => {
  const magicInserts = (engine: EngineHost, line: string): string[] =>
    engine
      .predict({ line, cursor: line.length, cwd: '/work' })
      .candidates.filter((c) => c.source === 'magic')
      .map((c) => c.display);

  it('creates, lists and resolves a handle', () => {
    const engine = host();
    expect(engine.namesCreate('dep', 'docker compose up -d', '/work')).toEqual({ created: true });
    expect(engine.namesList('/work').map((n) => n.name)).toEqual(['dep']);
    expect(magicInserts(engine, 'de')).toEqual(['docker compose up -d']);
  });

  it('rejects a handle that is taken or shadows the program name', () => {
    const engine = host();
    engine.namesCreate('dep', 'docker compose up -d', '/work');
    expect(engine.namesCreate('dep', 'git push', '/work')).toEqual({ created: false, reason: 'taken' });
    expect(engine.namesCreate('git', 'git push', '/work')).toEqual({ created: false, reason: 'command' });
  });

  it('deletes via tombstone and reports an unknown line', () => {
    const engine = host();
    engine.namesCreate('dep', 'docker compose up -d', '/work');
    expect(engine.namesDelete('docker compose up -d')).toBe(true);
    expect(engine.namesList('/work')).toEqual([]);
    expect(readFileSync(namesFile, 'utf8')).toContain('"name":""');
    expect(engine.namesDelete('never named')).toBe(false);
  });

  it('picks up a handle another process created, without a rebuild', () => {
    write([entry('git status')]);
    const engine = host();
    expect(magicInserts(engine, 'de')).toEqual([]);

    const foreign: MagicName = { name: 'dep', line: 'docker compose up -d', cwds: [], ts: 1_700_000_050_000 };
    appendFileSync(namesFile, `${JSON.stringify(foreign)}\n`);

    expect(magicInserts(engine, 'de')).toEqual(['docker compose up -d']);
    // Entry count untouched: reloading names must not rebuild the model.
    expect(engine.stats().entries).toBe(1);
  });

  it('stays dormant when magic names are disabled', () => {
    const engine = host({ magicNames: false });
    const foreign: MagicName = { name: 'dep', line: 'docker compose up -d', cwds: [], ts: 1_700_000_050_000 };
    appendFileSync(namesFile, `${JSON.stringify(foreign)}\n`);
    expect(magicInserts(engine, 'de')).toEqual([]);
  });
});

describe('EngineHost: compaction', () => {
  it('caps the file and keeps the newest entries', () => {
    write(Array.from({ length: 20 }, (_, i) => entry(`cmd-${i}`, { ts: 1_700_000_000_000 + i })));
    const engine = host({ maxEntries: 5 });
    expect(readFileSync(historyFile, 'utf8').trim().split('\n')).toHaveLength(5);
    expect(engine.stats().entries).toBe(5);
    expect(inserts(engine, 'cmd-19')).not.toEqual([]);
  });

  it('re-reads its own compaction so the offset stays valid', () => {
    write([entry('git status')]);
    const engine = host({ maxEntries: 2 });
    engine.learn(entry('npm test'));
    engine.learn(entry('cargo build'));
    engine.compact();
    expect(readFileSync(historyFile, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(engine.stats().entries).toBe(2);

    // The offset must point into the compacted file, not the old one.
    engine.learn(entry('ls -la'));
    expect(engine.stats().entries).toBe(3);
    expect(inserts(engine, 'ls ')).toContain('-la');
  });
});
