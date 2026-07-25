import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';
import {
  CheckDeps,
  MIN_NODE_MAJOR,
  checkEnvironment,
  formatCheck,
  initSnippet,
  pluginFilePath,
} from '../../src/plugin/init.js';

const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({
  binary: 'tabcat',
  run: (command, args) => {
    if (command === 'zsh' && args[0] === '--version') return { status: 0, stdout: 'zsh 5.9 (x86_64-apple-darwin)' };
    if (command === 'zsh' && args[0] === '-fc') return { status: 0, stdout: '' };
    if (command === 'tabcat' && args[0] === '--version') return { status: 0, stdout: `${VERSION}\n` };
    if (command === 'tabcat' && args[0] === 'daemon') return { status: 1, stdout: 'not running (socket /x)\n' };
    return { status: 1, stdout: '' };
  },
  readTextFile: () => 'source /somewhere/tabcat.plugin.zsh\n',
  env: { XDG_RUNTIME_DIR: '' },
  home: '/home/test',
  nodeVersion: '20.11.0',
  pluginFile: '/pkg/dist/tabcat.plugin.zsh',
  pluginFileExists: true,
  ...over,
});

const failing = (result: ReturnType<typeof checkEnvironment>): string[] =>
  result.lines.filter((line) => !line.ok).map((line) => line.text);

describe('plugin init: snippet', () => {
  it('points at the shipped plugin file', () => {
    expect(initSnippet('/pkg/dist/tabcat.plugin.zsh')).toContain('source /pkg/dist/tabcat.plugin.zsh');
  });

  it('quotes a path containing spaces', () => {
    expect(initSnippet('/Users/a b/dist/tabcat.plugin.zsh')).toContain("source '/Users/a b/dist/tabcat.plugin.zsh'");
  });

  it('resolves the plugin file that ships with this checkout', () => {
    // Either src/plugin/ (checkout) or dist/ (installed package) must exist.
    expect(existsSync(pluginFilePath())).toBe(true);
  });
});

describe('plugin init: --check', () => {
  it('passes on a healthy environment', () => {
    const result = checkEnvironment(deps());
    expect(failing(result)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails on an old node', () => {
    const result = checkEnvironment(deps({ nodeVersion: '18.19.0' }));
    expect(result.ok).toBe(false);
    expect(failing(result)[0]).toContain(`need >= ${MIN_NODE_MAJOR}`);
  });

  it('fails when zsh is missing', () => {
    const result = checkEnvironment(deps({ run: () => ({ status: 1, stdout: '' }) }));
    expect(result.ok).toBe(false);
    expect(failing(result).join(' ')).toContain('zsh not found');
  });

  it('fails when the tabcat in PATH has no daemon command', () => {
    // The failure that looks like a broken plugin: the plugin spawns whatever
    // PATH resolves to, and an older install has no `daemon` command, so every
    // spawn fails and the plugin disables itself. Both can report the same
    // version, so the probe asks for the command instead of comparing versions.
    const result = checkEnvironment(
      deps({
        run: (command, args) => {
          if (command === 'zsh' && args[0] === '--version') return { status: 0, stdout: 'zsh 5.9' };
          if (command === 'zsh') return { status: 0, stdout: '' };
          if (args[0] === 'daemon') return { status: 2, stdout: 'tabcat: Unknown command: daemon\nUsage: tabcat help\n' };
          return { status: 0, stdout: `${VERSION}\n` };
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(failing(result).join(' ')).toContain('has no `daemon` command');
  });

  it('notes a version difference without blocking', () => {
    const result = checkEnvironment(
      deps({
        run: (command, args) => {
          if (command === 'zsh' && args[0] === '--version') return { status: 0, stdout: 'zsh 5.9' };
          if (command === 'zsh') return { status: 0, stdout: '' };
          if (args[0] === 'daemon') return { status: 1, stdout: 'not running (socket /x)\n' };
          return { status: 0, stdout: '9.9.9\n' };
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(formatCheck(result)).toContain('note  tabcat in PATH is 9.9.9');
  });

  it('fails when tabcat is not in PATH at all', () => {
    const result = checkEnvironment(
      deps({
        run: (command, args) => {
          if (command === 'zsh' && args[0] === '--version') return { status: 0, stdout: 'zsh 5.9' };
          if (command === 'zsh') return { status: 0, stdout: '' };
          return { status: 127, stdout: 'command not found' };
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(failing(result).join(' ')).toContain('not found in PATH');
  });

  it('reports a custom TABCAT_BIN by name', () => {
    const result = checkEnvironment(deps({ binary: 'tabcat-dev' }));
    expect(failing(result).join(' ')).toContain('tabcat-dev not found in PATH');
  });

  it('fails on a zsh too old for zsocket', () => {
    const result = checkEnvironment(
      deps({ run: () => ({ status: 0, stdout: 'zsh 4.3.17 (x86_64-apple-darwin)' }) }),
    );
    expect(result.ok).toBe(false);
    expect(failing(result).join(' ')).toContain('zsh 4.3.17');
  });

  it('fails when the zsh/net/socket module cannot be loaded', () => {
    const result = checkEnvironment(
      deps({
        run: (command, args) =>
          args[0] === '-fc' ? { status: 1, stdout: 'failed' } : { status: 0, stdout: 'zsh 5.9' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(failing(result).join(' ')).toContain('zsh/net/socket');
  });

  it('fails when the socket path would exceed the sun_path limit', () => {
    const result = checkEnvironment(deps({ env: { XDG_RUNTIME_DIR: `/${'x'.repeat(120)}` } }));
    // A non-existent long directory falls back to /tmp, so this must be about
    // the real risk: an existing but very long runtime dir. Simulated here by a
    // path that is already too long on its own.
    expect(result.lines.some((line) => line.text.includes('socket path'))).toBe(true);
  });

  it('reports a missing .zshrc entry without failing the check', () => {
    const result = checkEnvironment(deps({ readTextFile: () => null }));
    expect(result.ok).toBe(true);
    expect(result.lines.some((line) => !line.ok && !line.blocking)).toBe(true);
    expect(formatCheck(result)).toContain('note  .zshrc does not source the plugin yet');
  });

  it('formats each line with a verdict', () => {
    const text = formatCheck(checkEnvironment(deps()));
    expect(text.split('\n').every((line) => /^(ok|FAIL|note) /.test(line))).toBe(true);
  });
});
