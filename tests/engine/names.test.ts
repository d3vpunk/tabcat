import { describe, expect, it } from 'vitest';
import {
  GLOBAL_SPECIFICITY, MAGIC_SCORE, MagicName, NameIndex, activeIn, cwdsFor, firstWord,
  handleIssue, isGlobal, makeName, scopeOf, specificityOf, validateHandle,
} from '../../src/engine/names.js';
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

describe('names: scope derivation', () => {
  it('derives the scope from cwds', () => {
    expect(scopeOf(name({ cwds: [CWD] }))).toBe('here');
    expect(scopeOf(name({ cwds: [] }))).toBe('global');
    expect(isGlobal(name({ cwds: [] }))).toBe(true);
    expect(isGlobal(name({ cwds: [CWD] }))).toBe(false);
  });

  it('cwdsFor is the inverse of scopeOf', () => {
    expect(cwdsFor('here', CWD)).toEqual([CWD]);
    expect(cwdsFor('global', CWD)).toEqual([]);
    expect(scopeOf(name({ cwds: cwdsFor('global', CWD) }))).toBe('global');
  });

  it('makeName is the only factory a caller needs', () => {
    expect(makeName('haiku', 'claude --model haiku', 'global', CWD, 7)).toEqual({
      name: 'haiku',
      line: 'claude --model haiku',
      cwds: [],
      ts: 7,
    });
    expect(makeName('dep', 'npm ci', 'here', CWD, 7).cwds).toEqual([CWD]);
  });

  it('ranks specificity: exact cwd beats global, foreign dirs do not apply', () => {
    expect(specificityOf(name({ cwds: [CWD] }), CWD)).toBe(0);
    expect(specificityOf(name({ cwds: [] }), CWD)).toBe(GLOBAL_SPECIFICITY);
    expect(specificityOf(name({ cwds: [OTHER] }), CWD)).toBeNull();
  });

  it('activeIn is specificityOf without the rank', () => {
    expect(activeIn(name({ cwds: [CWD] }), CWD)).toBe(true);
    expect(activeIn(name({ cwds: [] }), CWD)).toBe(true);
    expect(activeIn(name({ cwds: [OTHER] }), CWD)).toBe(false);
  });

  it('a global rank leaves room for intermediate steps (repo subtree, P2)', () => {
    // Regression guard for the comparator in Task 2: a finite rank keeps
    // subtraction defined (Infinity - Infinity is NaN) and leaves gaps.
    expect(GLOBAL_SPECIFICITY).toBeGreaterThan(1);
    expect(Number.isFinite(GLOBAL_SPECIFICITY)).toBe(true);
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

describe('NameIndex: prefix hint for the badge', () => {
  const named = (name: string, line: string, ts = 1_000, cwds: string[] = []): MagicName => ({ name, line, cwds, ts });

  it('finds a handle while the command is still being typed', () => {
    // The plugin badge must appear early — waiting for the exact line means the
    // user only learns about the shortcut after typing the whole command.
    const index = new NameIndex([named('dep', 'docker compose up -d')]);
    expect(index.handleForPrefix('docker com', '/w')).toBe('dep');
    expect(index.handleForPrefix('docker compose up -d', '/w')).toBe('dep');
  });

  it('ignores a prefix shorter than the minimum', () => {
    const index = new NameIndex([named('dep', 'docker compose up -d')]);
    expect(index.handleForPrefix('d', '/w')).toBeNull();
    expect(index.handleForPrefix('  ', '/w')).toBeNull();
    expect(index.handleForPrefix('do', '/w')).toBe('dep');
  });

  it('does not match a different command', () => {
    const index = new NameIndex([named('dep', 'docker compose up -d')]);
    expect(index.handleForPrefix('git stat', '/w')).toBeNull();
  });

  it('is case sensitive — the badge must describe what Tab would insert', () => {
    const index = new NameIndex([named('dep', 'Docker compose')]);
    expect(index.handleForPrefix('docker', '/w')).toBeNull();
    expect(index.handleForPrefix('Docker', '/w')).toBe('dep');
  });

  it('prefers the closest completion, newest on ties', () => {
    const index = new NameIndex([
      named('longer', 'deploy production with extra steps', 1_000),
      named('shorter', 'deploy production', 2_000),
    ]);
    expect(index.handleForPrefix('deploy p', '/w')).toBe('shorter');
  });

  it('respects the cwd scope', () => {
    const index = new NameIndex([named('dep', 'docker compose up -d', 1_000, ['/other'])]);
    expect(index.handleForPrefix('docker com', '/w')).toBeNull();
    expect(index.handleForPrefix('docker com', '/other')).toBe('dep');
  });

  it('tolerates leading whitespace in the typed line', () => {
    const index = new NameIndex([named('dep', 'docker compose up -d')]);
    expect(index.handleForPrefix('  docker com', '/w')).toBe('dep');
  });
});

describe('names: precedence (local beats global)', () => {
  const LOCAL = name({ name: 'dep', line: 'docker compose exec php composer install', cwds: [CWD], ts: 100 });
  const GLOBAL = name({ name: 'dep', line: 'npm ci --prefer-offline', cwds: [], ts: 200 });
  const index = () => new NameIndex([LOCAL, GLOBAL]);

  it('resolves to the local command in its directory, to the global one elsewhere', () => {
    expect(index().resolve('dep', CWD)).toBe(LOCAL.line);
    expect(index().resolve('dep', OTHER)).toBe(GLOBAL.line);
  });

  it('ignores the newer timestamp when the local one is more specific', () => {
    // GLOBAL.ts is higher — specificity has to win, or a later global handle
    // would silently shadow an older local one.
    expect(index().resolve('dep', CWD)).toBe(LOCAL.line);
  });

  it('offers each handle once, resolved by the most specific record', () => {
    const here = index().match('de', CWD);
    expect(here).toHaveLength(1);
    expect(here[0]?.display).toBe(LOCAL.line);
    expect(here[0]?.magicName).toBe('dep');

    const elsewhere = index().match('de', OTHER);
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0]?.display).toBe(GLOBAL.line);
  });

  it('still ranks a shorter handle before a longer one', () => {
    const withOther = new NameIndex([LOCAL, GLOBAL, name({ name: 'deploy', line: 'make deploy', cwds: [] })]);
    expect(withOther.match('de', CWD).map((c) => c.magicName)).toEqual(['dep', 'deploy']);
  });

  it('nameFor returns the record, handleFor stays its name', () => {
    expect(index().nameFor(LOCAL.line, CWD)).toEqual(LOCAL);
    expect(index().nameFor(LOCAL.line, OTHER)).toBeNull();
    expect(index().handleFor(GLOBAL.line, OTHER)).toBe('dep');
    expect(scopeOf(index().nameFor(GLOBAL.line, OTHER)!)).toBe('global');
  });
});
