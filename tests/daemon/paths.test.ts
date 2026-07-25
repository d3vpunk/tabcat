import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_SOCKET_PATH,
  SocketPathError,
  defaultSocketPath,
  ensureSocketDir,
  pidfileFor,
  resolveSocketPath,
} from '../../src/daemon/paths.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync('/tmp/tc-paths-');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('daemon paths: socket location', () => {
  it('prefers $XDG_RUNTIME_DIR when it exists', () => {
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: base }, 501)).toBe(join(base, 'tabcat', 'daemon.sock'));
  });

  it('falls back to /tmp/tabcat-<uid> without $XDG_RUNTIME_DIR', () => {
    expect(defaultSocketPath({}, 501)).toBe('/tmp/tabcat-501/daemon.sock');
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: '' }, 501)).toBe('/tmp/tabcat-501/daemon.sock');
  });

  it('falls back when $XDG_RUNTIME_DIR does not exist', () => {
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: join(base, 'nope') }, 501)).toBe('/tmp/tabcat-501/daemon.sock');
  });

  it('falls back when the resulting path would exceed the sun_path limit', () => {
    // A long runtime dir is the realistic case on macOS, where $TMPDIR-like
    // paths are ~50 characters before anything of ours is appended.
    const deep = join(base, 'a'.repeat(90));
    mkdirSync(deep, { recursive: true });
    expect(defaultSocketPath({ XDG_RUNTIME_DIR: deep }, 501)).toBe('/tmp/tabcat-501/daemon.sock');
  });

  it('puts the pidfile next to the history file', () => {
    expect(pidfileFor('/home/x/.config/tabcat/history.jsonl')).toBe('/home/x/.config/tabcat/daemon.pid');
  });
});

describe('daemon paths: effective socket', () => {
  it('prefers an explicit override over everything', () => {
    const env = { TABCAT_SOCKET: '/tmp/env.sock', XDG_RUNTIME_DIR: base };
    expect(resolveSocketPath('/tmp/flag.sock', env, 501)).toBe('/tmp/flag.sock');
  });

  it('falls back to $TABCAT_SOCKET before the computed default', () => {
    const env = { TABCAT_SOCKET: '/tmp/env.sock', XDG_RUNTIME_DIR: base };
    expect(resolveSocketPath(undefined, env, 501)).toBe('/tmp/env.sock');
  });

  it('treats an empty $TABCAT_SOCKET as unset', () => {
    // `: ${TABCAT_SOCKET:=}` in the plugin leaves exactly this in every shell
    // that never set the variable.
    expect(resolveSocketPath(undefined, { TABCAT_SOCKET: '' }, 501)).toBe('/tmp/tabcat-501/daemon.sock');
  });

  it('computes the default when nothing is configured', () => {
    expect(resolveSocketPath(undefined, { XDG_RUNTIME_DIR: base }, 501)).toBe(join(base, 'tabcat', 'daemon.sock'));
  });
});

describe('daemon paths: socket directory', () => {
  it('creates the directory with 0700', () => {
    const socketPath = join(base, 'run', 'daemon.sock');
    ensureSocketDir(socketPath);
    expect(statSync(join(base, 'run')).mode & 0o777).toBe(0o700);
  });

  it('tightens a directory that others could write to', () => {
    const dir = join(base, 'loose');
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    ensureSocketDir(join(dir, 'daemon.sock'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a path above the sun_path limit', () => {
    const long = join(base, 'x'.repeat(MAX_SOCKET_PATH), 'daemon.sock');
    expect(() => ensureSocketDir(long)).toThrow(SocketPathError);
  });

  it('refuses a symlinked socket directory', () => {
    // /tmp is world-writable: a symlink planted there could redirect the
    // socket into a directory someone else controls.
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    expect(() => ensureSocketDir(join(link, 'daemon.sock'))).toThrow(/symlink/);
  });

  it('refuses a directory owned by another user', () => {
    const dir = join(base, 'foreign');
    mkdirSync(dir);
    // Pretend we are someone else — same check the daemon does against /tmp.
    expect(() => ensureSocketDir(join(dir, 'daemon.sock'), 999_999)).toThrow(/belongs to uid/);
  });
});
