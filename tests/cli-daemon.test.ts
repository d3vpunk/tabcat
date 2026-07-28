import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliArgumentError, parseCliArgs } from '../src/cli-args.js';
import { pidfileFor } from '../src/daemon/paths.js';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

let dir: string;
let socketDir: string;
let historyFile: string;
let socketPath: string;
const children: ReturnType<typeof spawn>[] = [];

interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Runs the real CLI through tsx — the same entry point users get as `tabcat`. */
function cli(
  args: readonly string[],
  options: { detached?: boolean; env?: Record<string, string> } = {},
): Promise<CliResult> {
  const child = spawn('npx', ['tsx', CLI, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TABCAT_MAGIC_NAMES: '1', ...options.env },
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  if (options.detached === true) {
    // Long-running (`tabcat daemon`): resolve as soon as it says it is listening.
    return new Promise((resolve) => {
      const done = (): void => resolve({ stdout, stderr, status: 0 });
      child.stderr?.on('data', () => {
        if (stderr.includes('listening on') || stderr.includes('already running')) done();
      });
      child.on('close', done);
    });
  }
  return new Promise((resolve) => {
    child.on('close', (status) => resolve({ stdout, stderr, status: status ?? 1 }));
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabcat-cli-'));
  socketDir = mkdtempSync('/tmp/tc-cli-');
  historyFile = join(dir, 'history.jsonl');
  socketPath = join(socketDir, 'd.sock');
});

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.length = 0;
  rmSync(dir, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
});

describe('cli args: daemon and plugin', () => {
  it('parses the daemon subcommands', () => {
    expect(parseCliArgs(['daemon'])).toMatchObject({ command: 'daemon', subs: [] });
    expect(parseCliArgs(['daemon', 'status'])).toMatchObject({ command: 'daemon', subs: ['status'] });
    expect(parseCliArgs(['daemon', 'stop'])).toMatchObject({ command: 'daemon', subs: ['stop'] });
    expect(parseCliArgs(['daemon', 'path'])).toMatchObject({ command: 'daemon', subs: ['path'] });
    expect(parseCliArgs(['daemon', '--socket', '/tmp/x.sock'])).toMatchObject({ socket: '/tmp/x.sock' });
  });

  it('parses plugin init', () => {
    expect(parseCliArgs(['plugin', 'init'])).toMatchObject({ command: 'plugin', subs: ['init'] });
    expect(parseCliArgs(['plugin', 'init', 'zsh'])).toMatchObject({ command: 'plugin', subs: ['init', 'zsh'] });
    expect(parseCliArgs(['plugin', 'init', 'zsh', '--check'])).toMatchObject({ check: true });
  });

  it('parses simulate --json', () => {
    expect(parseCliArgs(['simulate', '--line', 'git', '--json'])).toMatchObject({ json: true, line: 'git' });
  });

  it.each([
    [['daemon', 'restart']],
    [['plugin']],
    [['plugin', 'init', 'bash']],
    [['plugin', 'init', 'zsh', 'extra']],
    [['stats', 'extra']],
    [['daemon', '--json']],
    [['simulate', '--check']],
    [['repl', '--socket', '/tmp/x']],
  ])('rejects %s', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(CliArgumentError);
  });
});

describe('cli: plugin init zsh', () => {
  it('prints a source line for .zshrc', async () => {
    const result = await cli(['plugin', 'init', 'zsh']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^# tabcat/m);
    expect(result.stdout).toMatch(/source .*tabcat\.plugin\.zsh/);
  });

  it('reports the environment with --check', async () => {
    const result = await cli(['plugin', 'init', 'zsh', '--check']);
    expect(result.stdout).toMatch(/(ok|FAIL|note)\s+node /);
    expect(result.stdout).toContain('zsh/net/socket');
    expect(result.stdout).toContain('socket path');
  });
});

describe('cli: daemon path', () => {
  // The macOS overlay reads this instead of reimplementing the sun_path rule, so
  // the contract is narrow on purpose: one line, no side effects, no daemon.
  it('prints exactly one line and exits zero without a daemon', async () => {
    const result = await cli(['daemon', 'path']);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(result.stdout.trim()).toMatch(/\/daemon\.sock$/);
  }, 60_000);

  it('does not create the socket directory', async () => {
    const unborn = join(socketDir, 'nested', 'd.sock');
    const result = await cli(['daemon', 'path', '--socket', unborn]);
    expect(result.stdout.trim()).toBe(unborn);
    expect(existsSync(join(socketDir, 'nested'))).toBe(false);
  }, 60_000);

  it('respects $TABCAT_SOCKET, and lets --socket win over it', async () => {
    const fromEnv = await cli(['daemon', 'path'], { env: { TABCAT_SOCKET: socketPath } });
    expect(fromEnv.stdout.trim()).toBe(socketPath);

    const flagWins = await cli(['daemon', 'path', '--socket', '/tmp/flag.sock'], {
      env: { TABCAT_SOCKET: socketPath },
    });
    expect(flagWins.stdout.trim()).toBe('/tmp/flag.sock');
  }, 60_000);

  it('finds the daemon that $TABCAT_SOCKET points at', async () => {
    // The regression this guards: status used to compute the default path and
    // report "not running" for a daemon the plugin had started elsewhere.
    await cli(['daemon', '--socket', socketPath, '--history', historyFile], { detached: true });
    const status = await cli(['daemon', 'status'], { env: { TABCAT_SOCKET: socketPath } });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('running: version');
  }, 60_000);
});

describe('cli: daemon lifecycle', () => {
  it('reports a missing daemon and exits non-zero', async () => {
    const result = await cli(['daemon', 'status', '--socket', socketPath]);
    expect(result.stdout).toContain('not running');
    expect(result.status).toBe(1);
  });

  it('starts, reports status, and stops', async () => {
    writeFileSync(historyFile, `${JSON.stringify({ ts: 1, cwd: '/w', line: 'git status' })}\n`);
    const started = cli(['daemon', '--socket', socketPath, '--history', historyFile], { detached: true });
    await started;
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidfileFor(historyFile))).toBe(true);

    const status = await cli(['daemon', 'status', '--socket', socketPath]);
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/running: version .*, protocol \d+, state (ready|warming), pid \d+/);

    const stop = await cli(['daemon', 'stop', '--socket', socketPath]);
    expect(stop.status).toBe(0);
    expect(stop.stdout).toContain('stopped');
    expect(existsSync(socketPath)).toBe(false);
  }, 60_000);

  it('refuses a second daemon on the same socket', async () => {
    await cli(['daemon', '--socket', socketPath, '--history', historyFile], { detached: true });
    const second = await cli(['daemon', '--socket', socketPath, '--history', historyFile]);
    expect(second.stderr).toContain('already running');
    // The desired end state already holds, so this is not a failure.
    expect(second.status).toBe(0);
  }, 60_000);
});

describe('cli: simulate --json', () => {
  it('prints machine-readable candidates', async () => {
    writeFileSync(
      historyFile,
      [
        JSON.stringify({ ts: 1, cwd: '/w', line: 'git status' }),
        JSON.stringify({ ts: 2, cwd: '/w', line: 'git status' }),
      ].join('\n') + '\n',
    );
    const result = await cli(['simulate', '--history', historyFile, '--line', 'git ', '--cwd', '/w', '--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { prefix: string; candidates: { display: string }[]; entries: number };
    expect(parsed.entries).toBe(2);
    expect(parsed.prefix).toBe('');
    expect(parsed.candidates.map((c) => c.display)).toContain('status');
  }, 60_000);
});
