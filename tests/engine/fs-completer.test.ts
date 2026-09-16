import { describe, expect, it } from 'vitest';
import { directoryExists } from '../../src/engine/fs-completer.js';
import { fakeFs } from './scenarios/helpers.js';

const CWD = '/home/dev/project';
const HOME = '/home/dev';
const fs = fakeFs({
  [CWD]: [{ name: 'src', isDir: true }, { name: 'README.md', isDir: false }],
  [`${CWD}/src`]: [{ name: 'engine', isDir: true }],
  [HOME]: [{ name: 'projects', isDir: true }],
});

describe('directoryExists', () => {
  it('finds a relative and a nested directory from cwd', () => {
    expect(directoryExists('src', CWD, fs)).toBe(true);
    expect(directoryExists('src/engine', CWD, fs)).toBe(true);
    expect(directoryExists('src/', CWD, fs)).toBe(true);
  });

  it('a file is not a directory, and neither is a missing name', () => {
    expect(directoryExists('README.md', CWD, fs)).toBe(false);
    expect(directoryExists('nope', CWD, fs)).toBe(false);
  });

  it('resolves absolute and home-relative paths', () => {
    expect(directoryExists(`${CWD}/src`, '/elsewhere', fs)).toBe(true);
    expect(directoryExists('~/projects', CWD, fs, HOME)).toBe(true);
    expect(directoryExists('~/nope', CWD, fs, HOME)).toBe(false);
  });

  it('the special targets always exist', () => {
    for (const target of ['', '.', '..', '-', '~', '~/', './', '../']) {
      expect(directoryExists(target, CWD, fs, HOME)).toBe(true);
    }
  });

  it('answers true whenever it cannot tell', () => {
    expect(directoryExists('~/projects', CWD, fs)).toBe(true); // no home directory known
    expect(directoryExists('$HOME/projects', CWD, fs, HOME)).toBe(true);
    expect(directoryExists('~alice/work', CWD, fs, HOME)).toBe(true);
    expect(directoryExists('proj*', CWD, fs, HOME)).toBe(true);
    expect(directoryExists('$(pwd)', CWD, fs, HOME)).toBe(true);
  });
});
