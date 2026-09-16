import { describe, expect, it } from 'vitest';
import { HOURS, PROJECT_A, PROJECT_B, fakeFs, predictor, repeat } from './helpers.js';

const HOME = '/home/dev';

/**
 * `cd` goes somewhere. A directory learned at home (`projects`) is the wrong
 * answer inside a project however frecent it is — a quarter of all `cd `
 * suggestions pointed at a directory that did not exist from where the user
 * stood. Existing directories rank first; the rest is demoted, never dropped.
 */
describe('Scenario: cd targets are checked against the filesystem', () => {
  const history = [
    ...repeat('cd projects', 10, 1 * HOURS, HOME),
    ...repeat('cd backend', 2, 3 * HOURS, PROJECT_A),
  ];
  const fs = fakeFs({
    [HOME]: [{ name: 'projects', isDir: true }],
    [PROJECT_A]: [{ name: 'backend', isDir: true }, { name: 'src', isDir: true }],
  });

  it('a directory that exists here beats a more frecent one that does not', () => {
    const p = predictor(history, fs);
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('backend');
  });

  it('the demoted directory stays in the list', () => {
    const p = predictor(history, fs);
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates.map((c) => c.display)).toContain('projects');
  });

  it('where the learned directory exists, nothing changes', () => {
    const p = predictor(history, fs);
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: HOME });

    expect(prediction.candidates[0]?.display).toBe('projects');
  });

  it('without an injected filesystem the ranking is untouched', () => {
    const p = predictor(history);
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('projects');
  });

  it('`..` always exists', () => {
    const p = predictor(
      [...repeat('cd projects', 10, 1 * HOURS, HOME), ...repeat('cd ..', 1, 5 * HOURS, PROJECT_B)],
      fakeFs({ [PROJECT_A]: [] }),
    );
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('..');
  });

  it('a nested path is checked against its parent directory', () => {
    const p = predictor(
      [...repeat('cd projects/radio', 5, 1 * HOURS, HOME), ...repeat('cd projects/tabby', 1, 5 * HOURS, HOME)],
      fakeFs({ [`${PROJECT_A}/projects`]: [{ name: 'tabby', isDir: true }] }),
    );
    const line = 'cd projects/';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('tabby');
  });

  it('a home-relative path is resolved against the home directory', () => {
    const p = predictor(
      [...repeat('cd temp', 5, 1 * HOURS, HOME), ...repeat('cd ~/projects', 1, 5 * HOURS, HOME)],
      fakeFs({ [HOME]: [{ name: 'projects', isDir: true }], [PROJECT_A]: [] }),
      HOME,
    );
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('~/projects');
  });

  it('only the directory of a compound command is checked', () => {
    const p = predictor(
      [...repeat('cd src', 5, 1 * HOURS, HOME), ...repeat('cd gui/macos && swift run', 1, 5 * HOURS, HOME)],
      fakeFs({ [PROJECT_A]: [{ name: 'gui', isDir: true }], [`${PROJECT_A}/gui`]: [{ name: 'macos', isDir: true }] }),
    );
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('gui/macos && swift run');
  });

  it('the branches after a bare `cd` are checked as well', () => {
    // `cd` alone often enough that the merge stops right after it: the fork
    // `cd` → END | ` projects` | ` backend` is what gets expanded.
    const p = predictor([...history, ...repeat('cd', 3, 2 * HOURS, HOME)], fs);
    const prediction = p.predict({ line: 'cd', cursor: 2, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe(' backend');
  });

  it('a command that merely starts with cd is not a cd', () => {
    const p = predictor([...repeat('cdk deploy', 10, 1 * HOURS, PROJECT_A), ...repeat('cd src', 1, 5 * HOURS, HOME)], fs);
    const prediction = p.predict({ line: 'cd', cursor: 2, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('cdk deploy');
  });

  it('an escaped space in the target is resolved before the check', () => {
    const p = predictor(
      [...repeat('cd other', 1, 5 * HOURS, PROJECT_A), ...repeat('cd My\\ Dir', 5, 1 * HOURS, HOME)],
      fakeFs({ [PROJECT_A]: [{ name: 'My Dir', isDir: true }, { name: 'other', isDir: true }] }),
    );
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('My\\ Dir');
  });

  it('a quoted target is resolved', () => {
    const p = predictor(
      [...repeat('cd other', 1, 5 * HOURS, PROJECT_A), ...repeat('cd "My Dir"', 5, 1 * HOURS, HOME)],
      fakeFs({ [PROJECT_A]: [{ name: 'My Dir', isDir: true }, { name: 'other', isDir: true }] }),
    );
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('"My Dir"');
  });

  it('flags before the target are skipped', () => {
    const p = predictor(
      [...repeat('cd other', 1, 5 * HOURS, PROJECT_A), ...repeat('cd -P src', 5, 1 * HOURS, HOME)],
      fakeFs({ [PROJECT_A]: [{ name: 'src', isDir: true }, { name: 'other', isDir: true }] }),
    );
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('-P src');
  });

  it('leading whitespace does not hide the cd', () => {
    const p = predictor(history, fs);
    const prediction = p.predict({ line: '  cd ', cursor: 5, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('backend');
  });

  it('cd at the end of a compound command is checked', () => {
    const p = predictor(
      [...repeat('git pull && cd nope', 5, 1 * HOURS, HOME), ...repeat('git pull && cd src', 1, 5 * HOURS, HOME)],
      fakeFs({ [PROJECT_A]: [{ name: 'src', isDir: true }] }),
    );
    const line = 'git pull && cd ';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('src');
  });

  it('`~/` and `~` are always reachable', () => {
    const p = predictor(
      [...repeat('cd nope', 5, 1 * HOURS, HOME), ...repeat('cd ~/', 1, 5 * HOURS, HOME), ...repeat('cd ~', 1, 6 * HOURS, HOME)],
      fakeFs({ [PROJECT_A]: [] }),
    );
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('~');
    expect(prediction.candidates.at(-1)?.display).toBe('nope');
  });

  it('a target the shell would expand cannot be judged and is not demoted', () => {
    const p = predictor(
      [...repeat('cd nope', 5, 1 * HOURS, HOME), ...repeat('cd $HOME/projects', 1, 5 * HOURS, HOME)],
      fakeFs({ [PROJECT_A]: [] }),
    );
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('$HOME/projects');
  });

  it('asks the filesystem once per candidate', () => {
    const names = Array.from({ length: 12 }, (_, i) => `dir${i}`);
    const base = fakeFs({ [PROJECT_A]: names.map((name) => ({ name, isDir: true })) });
    let asked = 0;
    const counting = { readdir: base.readdir, isDirectory: (path: string) => (asked++, base.isDirectory(path)) };
    const p = predictor(names.map((name, i) => repeat(`cd ${name}`, 1, (i + 1) * HOURS, PROJECT_A)).flat(), counting);
    const prediction = p.predict({ line: 'cd ', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates).toHaveLength(12);
    expect(asked).toBe(12);
  });

  it('other commands are not directories and stay untouched', () => {
    const p = predictor(
      [...repeat('make shell', 5, 1 * HOURS, HOME), ...repeat('make src', 1, 5 * HOURS, PROJECT_A)],
      fs,
    );
    const prediction = p.predict({ line: 'make ', cursor: 5, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('shell');
  });
});
