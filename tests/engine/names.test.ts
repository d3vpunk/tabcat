import { describe, expect, it } from 'vitest';
import { MAGIC_SCORE, MagicName, NameIndex, firstWord, handleIssue, validateHandle } from '../../src/engine/names.js';
import { Predictor } from '../../src/engine/predictor.js';

const CWD = '/home/dev/project';
const OTHER = '/home/dev/elsewhere';

const name = (overrides: Partial<MagicName> = {}): MagicName => ({
  name: 'phpstananalyze',
  line: 'docker compose run php vendor/bin/phpstan analyze src',
  cwds: [CWD],
  ts: 1000,
  ...overrides,
});

describe('names: firstWord', () => {
  it('returns the first word chunk', () => {
    expect(firstWord('docker compose run')).toBe('docker');
    expect(firstWord('  git status')).toBe('git');
    expect(firstWord('')).toBe('');
  });
});

describe('names: validateHandle', () => {
  const command = 'docker compose run php';

  it('accepts a well-formed handle and lowercases it', () => {
    expect(validateHandle('PhpStan1', command, [])).toBe('phpstan1');
  });

  it('rejects wrong shapes', () => {
    expect(validateHandle('ab', command, [])).toBeNull(); // too short
    expect(validateHandle('a'.repeat(17), command, [])).toBeNull(); // too long
    expect(validateHandle('1abc', command, [])).toBeNull(); // starts with digit
    expect(validateHandle('php-stan', command, [])).toBeNull(); // punctuation
    expect(validateHandle('', command, [])).toBeNull();
  });

  it('accepts the 3 and 16 char bounds', () => {
    expect(validateHandle('abc', command, [])).toBe('abc');
    expect(validateHandle('a'.repeat(16), command, [])).toBe('a'.repeat(16));
  });

  it('rejects the program name of the command', () => {
    expect(validateHandle('docker', command, [])).toBeNull();
    expect(validateHandle('Docker', command, [])).toBeNull();
  });

  it('rejects collisions case-insensitively', () => {
    expect(validateHandle('deploy', command, ['deploy'])).toBeNull();
    expect(validateHandle('deploy', command, ['DEPLOY'])).toBeNull();
    expect(validateHandle('deploy', command, ['other'])).toBe('deploy');
  });

  it('handleIssue names the reason', () => {
    expect(handleIssue('docker', command, [])).toBe('command');
    expect(handleIssue('deploy', command, ['deploy'])).toBe('taken');
    expect(handleIssue('deploy', command, [])).toBeNull();
  });
});

describe('names: NameIndex', () => {
  it('newest ts wins per command line', () => {
    const index = new NameIndex([name({ name: 'oldname', ts: 1000 }), name({ name: 'newname', ts: 2000 })]);
    expect(index.handleFor(name().line, CWD)).toBe('newname');
    expect(index.handles()).toEqual(['newname']);
  });

  it('add ignores older records for the same line', () => {
    const index = new NameIndex([name({ name: 'newname', ts: 2000 })]);
    index.add(name({ name: 'oldname', ts: 1000 }));
    expect(index.handleFor(name().line, CWD)).toBe('newname');
  });

  it('handles(cwd) hides handles that only live elsewhere; context-free stays', () => {
    const index = new NameIndex([
      name(),
      name({ line: 'cmd-b', name: 'elsewhere', cwds: [OTHER] }),
      name({ line: 'cmd-c', name: 'everywhere', cwds: [] }),
    ]);
    expect(index.handles(CWD).sort()).toEqual(['everywhere', 'phpstananalyze']);
    expect(index.handles().sort()).toEqual(['elsewhere', 'everywhere', 'phpstananalyze']);
  });

  it('has and remove work by line', () => {
    const index = new NameIndex([name()]);
    expect(index.has(name().line)).toBe(true);
    index.remove(name().line);
    expect(index.has(name().line)).toBe(false);
    expect(index.handleFor(name().line, CWD)).toBeNull();
  });

  it('handleFor is cwd-bound; empty cwds is context-free', () => {
    const index = new NameIndex([name(), name({ line: 'make deploy', name: 'everywhere', cwds: [] })]);
    expect(index.handleFor(name().line, CWD)).toBe('phpstananalyze');
    expect(index.handleFor(name().line, OTHER)).toBeNull();
    expect(index.handleFor('make deploy', OTHER)).toBe('everywhere');
  });

  it('resolve matches the exact handle in cwd only', () => {
    const index = new NameIndex([name()]);
    expect(index.resolve('phpstananalyze', CWD)).toBe(name().line);
    expect(index.resolve('phpstananalyze', OTHER)).toBeNull();
    expect(index.resolve('phpstan', CWD)).toBeNull(); // prefix is not exact
  });

  it('match filters by prefix and cwd, shorter handle first, then newest', () => {
    const index = new NameIndex([
      name({ name: 'phpstananalyze', line: 'cmd-a', ts: 1000 }),
      name({ name: 'phps', line: 'cmd-b', ts: 1000 }),
      name({ name: 'phpx', line: 'cmd-c', ts: 2000 }),
      name({ name: 'phpelse', line: 'cmd-d', cwds: [OTHER] }),
      name({ name: 'deploy', line: 'cmd-e' }),
    ]);
    const matches = index.match('php', CWD);
    expect(matches.map((m) => m.magicName)).toEqual(['phpx', 'phps', 'phpstananalyze']);
    expect(matches[0]).toMatchObject({
      display: 'cmd-c',
      insert: 'cmd-c'.slice(3),
      score: MAGIC_SCORE,
      source: 'magic',
      acceptedPrefixLength: 3,
      replacePrefixLength: 3,
    });
    expect(matches[1]?.score).toBe(MAGIC_SCORE - 1);
  });

  it('match is case-insensitive on the typed prefix', () => {
    const index = new NameIndex([name()]);
    expect(index.match('PHP', CWD)).toHaveLength(1);
  });

  it('insert stays non-empty when the handle is longer than the command', () => {
    // 'ls -la' named 'listall': typing 6+ chars of the handle must still be
    // Tab-acceptable — an empty insert would read as "nothing to accept".
    const index = new NameIndex([name({ name: 'listall', line: 'ls -la' })]);
    const [match] = index.match('listal', CWD);
    expect(match?.insert).not.toBe('');
    expect(match?.display).toBe('ls -la');
  });
});

describe('names: predictor integration', () => {
  const entries = [
    { ts: 1000, cwd: CWD, line: 'git status' },
    { ts: 1000, cwd: CWD, line: 'php artisan migrate' },
  ];

  it('magic candidates surface on the first token, above frecency', () => {
    const names = new NameIndex([name({ name: 'phpstananalyze' })]);
    const predictor = new Predictor(entries, { now: () => 2000, names });
    const { candidates } = predictor.predict({ line: 'php', cursor: 3, cwd: CWD });
    expect(candidates[0]).toMatchObject({ source: 'magic', magicName: 'phpstananalyze', display: name().line });
    expect(candidates.some((c) => c.source === 'history')).toBe(true);
  });

  it('does not surface magic candidates mid-line or without a prefix', () => {
    const names = new NameIndex([name({ name: 'phpstananalyze' })]);
    const predictor = new Predictor(entries, { now: () => 2000, names });
    expect(
      predictor.predict({ line: 'git php', cursor: 7, cwd: CWD }).candidates.every((c) => c.source !== 'magic'),
    ).toBe(true);
    expect(
      predictor.predict({ line: '', cursor: 0, cwd: CWD }).candidates.every((c) => c.source !== 'magic'),
    ).toBe(true);
  });

  it('is cwd-bound in the predictor too', () => {
    const names = new NameIndex([name({ name: 'phpstananalyze' })]);
    const predictor = new Predictor(entries, { now: () => 2000, names });
    expect(
      predictor.predict({ line: 'php', cursor: 3, cwd: OTHER }).candidates.every((c) => c.source !== 'magic'),
    ).toBe(true);
  });

  it('behaves exactly as before without a names index', () => {
    const withNames = new Predictor(entries, { now: () => 2000, names: new NameIndex() });
    const without = new Predictor(entries, { now: () => 2000 });
    expect(withNames.predict({ line: 'php', cursor: 3, cwd: CWD })).toEqual(
      without.predict({ line: 'php', cursor: 3, cwd: CWD }),
    );
  });
});
