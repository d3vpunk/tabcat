import { describe, expect, it } from 'vitest';
import { parseZshHistory } from '../../src/engine/zsh-import.js';

describe('zsh_history import', () => {
  it('parses extended format with timestamps', () => {
    const content = [
      ': 1752900000:0;git status',
      ': 1752900100:5;vendor/bin/tool --filter="x"',
    ].join('\n');

    const entries = parseZshHistory(content, '/p', 0);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ ts: 1752900000000, cwd: '/p', line: 'git status' });
    expect(entries[1]?.line).toBe('vendor/bin/tool --filter="x"');
  });

  it('plain format gets the fallback timestamp', () => {
    const entries = parseZshHistory('ls -la\n\ngit pull', '/p', 42);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.ts === 42)).toBe(true);
  });

  it('uses neutral cwd for global shell history', () => {
    expect(parseZshHistory(': 1752900000:0;git status', null, 0)[0]?.cwd).toBeNull();
  });

  it('multi-line commands stay a single entry (extended format)', () => {
    const content = [
      ': 1752900000:0;git commit -m "first line',
      'second line"',
      ': 1752900100:0;git status',
    ].join('\n');

    const entries = parseZshHistory(content, '/p', 0);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.line).toBe('git commit -m "first line\nsecond line"');
    expect(entries[1]?.line).toBe('git status');
  });

  it('discards plain lines before the first extended entry', () => {
    const content = ['orphaned', ': 1752900000:0;git status'].join('\n');
    const entries = parseZshHistory(content, '/p', 0);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.line).toBe('git status');
  });
});
