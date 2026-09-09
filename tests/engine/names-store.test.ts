import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MagicName, makeName, scopeOf } from '../../src/engine/names.js';
import { appendName, appendTombstone, isMagicName, namesFileFor, readNames } from '../../src/engine/names-store.js';

const name = (overrides: Partial<MagicName> = {}): MagicName => ({
  name: 'deploy',
  line: 'kubectl apply -f deploy.yaml',
  cwds: ['/home/dev/project'],
  ts: 1000,
  ...overrides,
});

describe('names-store', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tabcat-names-'));
    file = join(dir, 'names.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('namesFileFor is a sibling of the history file', () => {
    expect(namesFileFor('/home/dev/.config/tabcat/history.jsonl')).toBe('/home/dev/.config/tabcat/names.jsonl');
  });

  it('append/read round-trip', () => {
    appendName(file, name());
    expect(readNames(file)).toEqual([name()]);
  });

  it('missing file reads as empty', () => {
    expect(readNames(file)).toEqual([]);
  });

  it('last record per command line wins', () => {
    appendName(file, name({ name: 'oldname', ts: 1000 }));
    appendName(file, name({ name: 'newname', ts: 2000 }));
    const names = readNames(file);
    expect(names).toHaveLength(1);
    expect(names[0]?.name).toBe('newname');
  });

  it('skips broken and invalid lines silently', () => {
    writeFileSync(
      file,
      [
        'not json at all',
        JSON.stringify({ name: 'no-line', cwds: [], ts: 1 }),
        JSON.stringify(name({ name: 'UPPER' })), // invalid shape (uppercase)
        JSON.stringify(name()),
      ].join('\n') + '\n',
    );
    expect(readNames(file)).toEqual([name()]);
  });

  it('a tombstone (empty name) deletes the line, append-only', () => {
    appendName(file, name());
    appendName(file, name({ name: '', cwds: [], ts: 2000 }));
    expect(readNames(file)).toEqual([]);
    // Append-only: both records are still physically present.
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('re-naming after a tombstone resurrects the line', () => {
    appendName(file, name({ ts: 1000 }));
    appendName(file, name({ name: '', cwds: [], ts: 2000 }));
    appendName(file, name({ name: 'reborn', ts: 3000 }));
    expect(readNames(file).map((n) => n.name)).toEqual(['reborn']);
  });

  it('busy lock is a silent no-op', () => {
    appendFileSync(file, '');
    const release = lockfile.lockSync(file, { realpath: false });
    try {
      expect(() => appendName(file, name())).not.toThrow();
      expect(readNames(file)).toEqual([]);
    } finally {
      release();
    }
  });

  it('isMagicName validates the record shape', () => {
    expect(isMagicName(name())).toBe(true);
    expect(isMagicName(name({ name: '' }))).toBe(true); // tombstone
    expect(isMagicName({ ...name(), name: 'Has-Hyphen' })).toBe(false);
    expect(isMagicName({ ...name(), line: '  ' })).toBe(false);
    expect(isMagicName({ ...name(), cwds: [1] })).toBe(false);
    expect(isMagicName({ ...name(), ts: Number.NaN })).toBe(false);
    expect(isMagicName(null)).toBe(false);
  });
});

describe('names-store: appendTombstone', () => {
  it('drops the handle of a line and survives a round trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-tomb-'));
    const file = join(dir, 'names.jsonl');
    appendName(file, makeName('haiku', 'claude --model haiku', 'global', '/p', 1));
    expect(readNames(file).map((n) => n.name)).toEqual(['haiku']);

    expect(appendTombstone(file, 'claude --model haiku', 2)).toBe(true);
    expect(readNames(file)).toEqual([]);
  });

  it('keeps a global record readable — cwds: [] is a scope, not a marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-tomb-'));
    const file = join(dir, 'names.jsonl');
    appendName(file, makeName('haiku', 'claude --model haiku', 'global', '/p', 1));
    const [read] = readNames(file);
    expect(read?.cwds).toEqual([]);
    expect(scopeOf(read!)).toBe('global');
  });
});
