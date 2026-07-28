import { describe, expect, it } from 'vitest';
import { osc7Cwd } from '../../src/repl/osc.js';

describe('osc7Cwd', () => {
  it('wraps the path in an OSC 7 file URL with ESC/BEL framing', () => {
    expect(osc7Cwd('/Users/jo/projects', 'mymac')).toBe('\u001b]7;file://mymac/Users/jo/projects\u0007');
  });

  it('percent-encodes spaces and non-ASCII, keeps slashes', () => {
    expect(osc7Cwd('/tmp/my dir/über', 'h')).toBe('\u001b]7;file://h/tmp/my%20dir/%C3%BCber\u0007');
  });

  it('defaults the host to the machine hostname', () => {
    const sequence = osc7Cwd('/tmp');
    expect(sequence.startsWith('\u001b]7;file://')).toBe(true);
    expect(sequence.endsWith('/tmp\u0007')).toBe(true);
    // No empty authority — terminals use the host to tell local from remote.
    expect(sequence).not.toContain('file:///tmp');
  });
});
