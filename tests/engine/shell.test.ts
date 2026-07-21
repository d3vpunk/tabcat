import { describe, expect, it } from 'vitest';
import { bashShell, detectShell, resolveShellPath, zshShell } from '../../src/engine/shell.js';

describe('detectShell', () => {
  const available = (...names: string[]) => (file: string) => names.includes(file);

  it('bash from $SHELL', () => {
    expect(detectShell({ SHELL: '/bin/bash' }, available('bash', 'zsh')).name).toBe('bash');
    expect(detectShell({ SHELL: '/usr/local/bin/bash' }, available('bash', 'zsh')).name).toBe('bash');
  });

  it('zsh from $SHELL', () => {
    expect(detectShell({ SHELL: '/bin/zsh' }, available('bash', 'zsh')).name).toBe('zsh');
  });

  it('falls back to bash, then zsh when $SHELL is missing or unknown', () => {
    expect(detectShell({}, available('bash', 'zsh')).name).toBe('bash');
    expect(detectShell({ SHELL: '/usr/bin/fish' }, available('bash', 'zsh')).name).toBe('bash');
    expect(detectShell({}, available('zsh')).name).toBe('zsh');
  });

  it('falls back to the other supported shell when $SHELL is not installed', () => {
    expect(detectShell({ SHELL: '/bin/zsh' }, available('bash')).name).toBe('bash');
    expect(detectShell({ SHELL: '/bin/bash' }, available('zsh')).name).toBe('zsh');
  });

  it('rejects environments without bash and zsh with a clear message', () => {
    expect(() => detectShell({ SHELL: '/usr/bin/fish' }, available())).toThrow(
      'No supported shell found ($SHELL=/usr/bin/fish). tabcat requires bash or zsh in PATH.',
    );
  });
});

describe('resolveShellPath', () => {
  it('prefers $SHELL when it points at this shell and exists', () => {
    const exists = (p: string) => p === '/bin/zsh';
    expect(resolveShellPath(zshShell, { SHELL: '/bin/zsh' }, exists)).toBe('/bin/zsh');
  });

  it('ignores $SHELL for a different shell and searches PATH', () => {
    const exists = (p: string) => p === '/usr/local/bin/bash';
    expect(resolveShellPath(bashShell, { SHELL: '/bin/zsh', PATH: '/usr/local/bin:/usr/bin' }, exists))
      .toBe('/usr/local/bin/bash');
  });

  it('falls back to well-known locations when PATH lacks the shell', () => {
    const exists = (p: string) => p === '/bin/zsh';
    expect(resolveShellPath(zshShell, { PATH: '/nowhere' }, exists)).toBe('/bin/zsh');
  });

  it('falls back to the bare name when nothing is found', () => {
    expect(resolveShellPath(bashShell, { PATH: '/nowhere' }, () => false)).toBe('bash');
  });
});

describe('ShellAdapter', () => {
  it('bash needs expand_aliases in the exec script, zsh does not', () => {
    expect(bashShell.execPreamble).toContain('expand_aliases');
    expect(zshShell.execPreamble).toBe('');
  });

  it('history paths per shell', () => {
    expect(zshShell.defaultHistoryPath('/home/u')).toBe('/home/u/.zsh_history');
    expect(bashShell.defaultHistoryPath('/home/u')).toBe('/home/u/.bash_history');
  });

  it('snapshot aliases are reusable as preamble (same output format)', () => {
    // Both zsh `alias -L` and bash `alias -p` write `alias name='...'`.
    expect(zshShell.snapshotArgs('/tmp/aliases')).toContain("alias -L > '/tmp/aliases'");
    expect(bashShell.snapshotArgs('/tmp/aliases')).toContain("alias -p > '/tmp/aliases'");
  });
});
