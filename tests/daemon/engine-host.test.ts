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

  it('does not rebuild while a writer sits mid-append', () => {
    // The offset legitimately points into an unterminated line then. Probing it
    // for a newline made every request from every shell rebuild the whole model
    // (measured: 4 rebuilds across 5 requests) until the writer finished.
    write([entry('git status')]);
    const engine = host();
    const base = engine.stats().rebuilds;
    const pending = JSON.stringify(entry('deploy production'));
    appendFileSync(historyFile, pending.slice(0, 20));
    for (let i = 0; i < 5; i++) inserts(engine, 'g');
    expect(engine.stats().rebuilds).toBe(base);

    appendFileSync(historyFile, `${pending.slice(20)}\n`);
    expect(inserts(engine, 'deploy ')).toContain('production');
    expect(engine.stats().rebuilds).toBe(base);
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
    expect(engine.namesCreate('dep', 'docker compose up -d', '/work', 'here')).toEqual({ created: true });
    expect(engine.namesList('/work').map((n) => n.name)).toEqual(['dep']);
    expect(magicInserts(engine, 'de')).toEqual(['docker compose up -d']);
  });

  it('rejects a handle that is taken or shadows the program name', () => {
    const engine = host();
    engine.namesCreate('dep', 'docker compose up -d', '/work', 'here');
    expect(engine.namesCreate('dep', 'git push', '/work', 'here')).toEqual({ created: false, reason: 'taken' });
    expect(engine.namesCreate('git', 'git push', '/work', 'here')).toEqual({ created: false, reason: 'command' });
  });

  it('deletes via tombstone and reports an unknown line', () => {
    const engine = host();
    engine.namesCreate('dep', 'docker compose up -d', '/work', 'here');
    expect(engine.namesDelete('docker compose up -d')).toBe(true);
    expect(engine.namesList('/work')).toEqual([]);
    expect(readFileSync(namesFile, 'utf8')).toContain('"name":""');
    expect(engine.namesDelete('never named')).toBe(false);
  });

  it('creates a global handle that resolves from any directory', () => {
    const engine = host();
    expect(engine.namesCreate('haiku', 'claude --model haiku', '/projects/a', 'global').created).toBe(true);
    expect(engine.resolveHandle('haiku', '/projects/b')).toBe('claude --model haiku');
  });

  it('a local handle elsewhere does not block going global', () => {
    const engine = host();
    engine.namesCreate('dep', 'cargo build', '/projects/a', 'here');
    expect(engine.namesCreate('dep', 'npm ci', '/projects/b', 'global').created).toBe(true);
    expect(engine.resolveHandle('dep', '/projects/a')).toBe('cargo build');
    expect(engine.resolveHandle('dep', '/projects/b')).toBe('npm ci');
  });

  it('a handle taken on the same level is still rejected', () => {
    const engine = host();
    engine.namesCreate('haiku', 'claude --model haiku', '/projects/a', 'global');
    expect(engine.namesCreate('haiku', 'other command', '/projects/b', 'global')).toEqual({
      created: false,
      reason: 'taken',
    });
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

describe('EngineHost: cwds', () => {
  const paths = (engine: EngineHost, limit = 10): string[] => engine.cwds(limit).map((c) => c.path);

  it('ranks directories by frecency, not by raw count', () => {
    // /old has three times the commands but they are two weeks stale; the short
    // term dominates, so one fresh command in /new outranks them.
    const twoWeeks = 1_700_000_100_000 - 14 * 86_400_000;
    write([
      entry('a', { cwd: '/old', ts: twoWeeks }),
      entry('b', { cwd: '/old', ts: twoWeeks + 1 }),
      entry('c', { cwd: '/old', ts: twoWeeks + 2 }),
      entry('d', { cwd: '/new', ts: 1_700_000_099_000 }),
    ]);
    expect(paths(host())).toEqual(['/new', '/old']);
  });

  it('honours the limit', () => {
    write([entry('a', { cwd: '/one' }), entry('b', { cwd: '/two' }), entry('c', { cwd: '/three' })]);
    expect(host().cwds(2)).toHaveLength(2);
  });

  it('skips imported entries, which carry no directory', () => {
    write([entry('a', { cwd: null }), entry('b', { cwd: '/work' })]);
    expect(paths(host())).toEqual(['/work']);
  });

  it('is empty for a history that only came from an import', () => {
    // A fresh install: the GUI needs to see this and fall back to its own seed.
    write([entry('a', { cwd: null }), entry('b', { cwd: null })]);
    expect(host().cwds(10)).toEqual([]);
  });

  it('treats a trailing slash as the same directory', () => {
    write([entry('a', { cwd: '/work' }), entry('b', { cwd: '/work/' })]);
    expect(paths(host())).toEqual(['/work']);
  });

  it('keeps the sample list bounded and still reports the newest use', () => {
    const first = 1_700_000_000_000;
    write(Array.from({ length: 200 }, (_, i) => entry(`cmd-${i}`, { cwd: '/work', ts: first + i })));
    const [only] = host({ maxEntries: 500 }).cwds(10);
    expect(only?.path).toBe('/work');
    expect(only?.lastUsed).toBe(first + 199);
    expect(Number.isFinite(only?.score)).toBe(true);
  });

  it('reports the newest timestamp even when the file is out of order', () => {
    // A clock that jumped backwards appends an older entry after a newer one.
    write([
      entry('a', { cwd: '/work', ts: 1_700_000_050_000 }),
      entry('b', { cwd: '/work', ts: 1_700_000_040_000 }),
    ]);
    expect(host().cwds(10)[0]?.lastUsed).toBe(1_700_000_050_000);
  });

  it('sees a directory another process appended', () => {
    // The REPL and `import` write history.jsonl directly. Those entries reach
    // the index only through the tail follow, never through learn().
    write([entry('a', { cwd: '/work' })]);
    const engine = host();
    expect(paths(engine)).toEqual(['/work']);
    append(entry('b', { cwd: '/elsewhere', ts: 1_700_000_099_999 }));
    expect(paths(engine)).toEqual(['/elsewhere', '/work']);
  });

  it('does not double count after a compaction rebuild', () => {
    write([entry('a', { cwd: '/work' })]);
    const engine = host({ maxEntries: 2 });
    engine.learn(entry('b', { cwd: '/work' }));
    engine.learn(entry('c', { cwd: '/work' }));
    const before = engine.cwds(10)[0];
    engine.compact();
    const after = engine.cwds(10)[0];
    // Compaction keeps 2 of 3 entries, so the score may drop — but a missing
    // reset in loadAll() would make it grow instead.
    expect(after?.score).toBeLessThanOrEqual(before?.score ?? 0);
    expect(engine.stats().entries).toBe(2);
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

  it('does not rebuild when compaction had nothing to do', () => {
    // compactHistory only rewrites the file above the cap. Rebuilding anyway
    // froze every connected shell every six hours for nothing.
    write([entry('git status'), entry('npm test', { ts: 1_700_000_000_001 })]);
    const engine = host({ maxEntries: 100 });
    const base = engine.stats().rebuilds;
    engine.compact();
    expect(engine.stats().rebuilds).toBe(base);
    expect(inserts(engine, 'git ')).toContain('status');
  });

  it('re-reads its own compaction so the offset stays valid', () => {
    write([entry('git status')]);
    const engine = host({ maxEntries: 2 });
    engine.learn(entry('npm test'));
    engine.learn(entry('cargo build'));
    const before = engine.stats().rebuilds;
    engine.compact();
    expect(readFileSync(historyFile, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(engine.stats().entries).toBe(2);
    // A real compaction renames the file, so the inode check rebuilds.
    expect(engine.stats().rebuilds).toBeGreaterThan(before);

    // The offset must point into the compacted file, not the old one.
    engine.learn(entry('ls -la'));
    expect(engine.stats().entries).toBe(3);
    expect(inserts(engine, 'ls ')).toContain('-la');
  });
});

describe('EngineHost: forget', () => {
  it('removes every occurrence, rebuilds, and stops suggesting the line', () => {
    write([entry('cd]'), entry('git status'), entry('cd]')]);
    const engine = host();
    expect(inserts(engine, 'cd')).toContain(']');

    expect(engine.forget('cd]')).toBe(2);

    expect(readFileSync(historyFile, 'utf8')).not.toContain('cd]');
    expect(engine.stats().entries).toBe(1);
    expect(inserts(engine, 'cd')).not.toContain(']');
  });

  it('drops the line from search results too', () => {
    write([entry('npm test'), entry('npm run lint')]);
    const engine = host();
    expect(engine.search('npm', 10)).toContain('npm test');

    engine.forget('npm test');

    expect(engine.search('npm', 10)).not.toContain('npm test');
  });

  it('a line that is not there is 0 and no rebuild', () => {
    write([entry('ls')]);
    const engine = host();
    const before = engine.stats().rebuilds;

    expect(engine.forget('never typed')).toBe(0);
    expect(engine.stats().rebuilds).toBe(before);
  });

  it('a foreign learn appended before the forget survives it', () => {
    write([entry('ls')]);
    const engine = host();
    // Another shell appends without asking the daemon.
    append(entry('git push'));

    engine.forget('ls');

    expect(engine.search('git', 10)).toContain('git push');
    expect(readFileSync(historyFile, 'utf8')).toContain('git push');
  });
});
