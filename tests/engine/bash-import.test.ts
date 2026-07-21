import { describe, expect, it } from 'vitest';
import { parseBashHistory } from '../../src/engine/bash-import.js';

describe('parseBashHistory', () => {
  const cwd = '/work';
  const fallback = 1000;

  it('without HISTTIMEFORMAT: every line is a command with fallbackTs', () => {
    expect(parseBashHistory('ls\ngit status\n', cwd, fallback)).toEqual([
      { ts: fallback, cwd, line: 'ls' },
      { ts: fallback, cwd, line: 'git status' },
    ]);
  });

  it('HISTTIMEFORMAT comment (#epoch) provides the timestamp of the following line', () => {
    const entries = parseBashHistory('#1721000000\ngit push\nls\n', cwd, fallback);
    expect(entries[0]).toEqual({ ts: 1_721_000_000_000, cwd, line: 'git push' });
    expect(entries[1]).toEqual({ ts: fallback, cwd, line: 'ls' });
  });

  it('short #-lines are commands, not timestamps', () => {
    expect(parseBashHistory('#42\n', cwd, fallback)).toEqual([{ ts: fallback, cwd, line: '#42' }]);
  });

  it('multiple consecutive timestamps: the last one wins', () => {
    expect(parseBashHistory('#1721000000\n#1721000099\nmake\n', cwd, fallback)).toEqual([
      { ts: 1_721_000_099_000, cwd, line: 'make' },
    ]);
  });

  it('skips empty lines', () => {
    expect(parseBashHistory('ls\n\n\npwd\n', cwd, fallback).map((e) => e.line)).toEqual(['ls', 'pwd']);
  });

  it('uses neutral cwd for global shell history', () => {
    expect(parseBashHistory('git status\n', null, fallback)[0]?.cwd).toBeNull();
  });
});
