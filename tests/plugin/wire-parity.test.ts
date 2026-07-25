import { describe, expect, it } from 'vitest';
import { escapeField, unescapeField } from '../../src/daemon/protocol.js';
import { defaultSocketPath, resolveSocketPath } from '../../src/daemon/paths.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROW, hasZsh, runZsh, splitRows, withPlugin } from './harness.js';

const zsh = hasZsh();

/**
 * The shell and the daemon each implement the wire format once — in different
 * languages. These tests pin the two implementations to each other; a drift
 * here would corrupt every command line containing a tab or a backslash.
 */
const NASTY = [
  'git status',
  "awk -F'\\t' '{print $1}' data",
  'C:\\Users\\test',
  'echo a\tb',
  'for f in *; do\n  echo $f\ndone',
  'echo "$HOME" *.ts ?x [a-z]',
  'printf "a\\nb"',
  '\\',
  '\\\\',
  'trailing\\',
  'echo ä ö 日本語 🐈',
  'x'.repeat(300),
  '%s %% $(cmd) `cmd` ${var}',
];

describe.skipIf(!zsh)('plugin wire parity: escaping', () => {
  it('escapes exactly like escapeField() in the daemon', () => {
    // zsh escapes, the assertions compare against the TypeScript encoder.
    const script = withPlugin(`
      local value
      for value in "$@"; do
        _tabcat_esc $value
        print -r -- $REPLY
      done
    `);
    const result = runZsh(script, { args: NASTY });
    expect(result.status).toBe(0);
    const escaped = result.stdout.split('\n').slice(0, -1);
    expect(escaped).toEqual(NASTY.map(escapeField));
  });

  it('escaped shell output survives the daemon-side decoder', () => {
    const script = withPlugin(`
      local value
      for value in "$@"; do
        _tabcat_esc $value
        print -r -- $REPLY
      done
    `);
    const escaped = runZsh(script, { args: NASTY }).stdout.split('\n').slice(0, -1);
    expect(escaped.map(unescapeField)).toEqual(NASTY);
  });

  it('decodes daemon-escaped fields back to the original', () => {
    // ${(g::)} must resolve \\ \t \n \r in a single pass — a chained
    // replacement would turn an escaped backslash-t into a real tab.
    const script = withPlugin(`
      local value
      for value in "$@"; do
        _tabcat_dec $value
        print -rn -- "\${REPLY}${ROW}"
      done
    `);
    const result = runZsh(script, { args: NASTY.map(escapeField) });
    expect(result.status).toBe(0);
    expect(splitRows(result.stdout)).toEqual(NASTY);
  });

  it('splits a response row into fields, keeping empty ones', () => {
    // A leading empty field (magic candidate with an empty insert) would shift
    // every following field if the split dropped it.
    const script = withPlugin(`
      local row=$'\\tstatus\\thistory\\t\\t5'
      local -a fields=("\${(@ps:\\t:)row}")
      print -r -- "count=\${#fields}"
      local i
      for (( i = 1; i <= \${#fields}; i++ )); do print -rn -- "\${fields[$i]}${ROW}"; done
    `);
    const result = runZsh(script);
    expect(result.stdout.split('\n')[0]).toBe('count=5');
    expect(splitRows(result.stdout.split('\n').slice(1).join('\n'))).toEqual(['', 'status', 'history', '', '5']);
  });

  it('reads a line without stripping leading or trailing tabs', () => {
    const script = withPlugin(`
      print -r -- $'ok\\tz1\\t' > $1
      local line
      IFS= read -r line < $1
      print -r -- "len=\${#line}"
      local -a fields=("\${(@ps:\\t:)line}")
      print -r -- "count=\${#fields}"
    `);
    const dir = mkdtempSync('/tmp/tc-read-');
    try {
      const result = runZsh(script, { args: [join(dir, 'line.txt')] });
      expect(result.stdout.trim().split('\n')).toEqual(['len=6', 'count=3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!zsh)('plugin wire parity: socket path', () => {
  const socketPathFromZsh = (env: Record<string, string>): string =>
    runZsh(withPlugin('_tabcat_socket_path\nprint -r -- $REPLY'), { env }).stdout.trim();

  it('agrees with defaultSocketPath() without XDG_RUNTIME_DIR', () => {
    expect(socketPathFromZsh({})).toBe(defaultSocketPath({}, process.getuid?.() ?? 0));
  });

  it('agrees when XDG_RUNTIME_DIR exists', () => {
    const dir = mkdtempSync('/tmp/tc-xdg-');
    try {
      const env = { XDG_RUNTIME_DIR: dir };
      expect(socketPathFromZsh(env)).toBe(defaultSocketPath(env, process.getuid?.() ?? 0));
      expect(socketPathFromZsh(env)).toBe(join(dir, 'tabcat', 'daemon.sock'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('agrees when XDG_RUNTIME_DIR does not exist', () => {
    const env = { XDG_RUNTIME_DIR: '/tmp/tc-does-not-exist-42' };
    expect(socketPathFromZsh(env)).toBe(defaultSocketPath(env, process.getuid?.() ?? 0));
  });

  it('agrees on the sun_path fallback for a long runtime dir', () => {
    const base = mkdtempSync('/tmp/tc-long-');
    const deep = join(base, 'a'.repeat(90));
    mkdirSync(deep, { recursive: true });
    try {
      const env = { XDG_RUNTIME_DIR: deep };
      expect(socketPathFromZsh(env)).toBe(defaultSocketPath(env, process.getuid?.() ?? 0));
      expect(socketPathFromZsh(env)).toMatch(/^\/tmp\/tabcat-\d+\/daemon\.sock$/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// Not just the computed default: the plugin and the CLI have to agree on the
// FULL precedence, or a shell with $TABCAT_SOCKET set connects to one socket
// while `tabcat daemon status` inspects another.
describe.skipIf(!zsh)('plugin wire parity: effective socket', () => {
  const effectiveFromZsh = (env: Record<string, string>): string =>
    runZsh(withPlugin('_tabcat_effective_socket\nprint -r -- $REPLY'), { env }).stdout.trim();

  it('agrees when $TABCAT_SOCKET is set', () => {
    const env = { TABCAT_SOCKET: '/tmp/tc-env.sock' };
    expect(effectiveFromZsh(env)).toBe(resolveSocketPath(undefined, env, process.getuid?.() ?? 0));
    expect(effectiveFromZsh(env)).toBe('/tmp/tc-env.sock');
  });

  it('agrees that an empty $TABCAT_SOCKET means unset', () => {
    // The state `: ${TABCAT_SOCKET:=}` leaves behind in every ordinary shell.
    const env = { TABCAT_SOCKET: '' };
    expect(effectiveFromZsh(env)).toBe(resolveSocketPath(undefined, env, process.getuid?.() ?? 0));
  });

  it('agrees on the computed default when nothing is set', () => {
    const dir = mkdtempSync('/tmp/tc-eff-');
    try {
      const env = { XDG_RUNTIME_DIR: dir };
      expect(effectiveFromZsh(env)).toBe(resolveSocketPath(undefined, env, process.getuid?.() ?? 0));
      expect(effectiveFromZsh(env)).toBe(join(dir, 'tabcat', 'daemon.sock'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not leak REPLY into the caller', () => {
    // The plugin runs this inside the user's shell; a stray global REPLY would
    // show up in unrelated scripts.
    const script = withPlugin('_tabcat_setup >/dev/null 2>&1\nprint -r -- "leak=${REPLY:-none}"');
    expect(runZsh(script, { env: { TABCAT_SOCKET: '/tmp/tc-leak.sock' } }).stdout).toContain('leak=none');
  });
});
