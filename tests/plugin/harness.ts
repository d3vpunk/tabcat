import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PLUGIN_FILE = fileURLToPath(new URL('../../src/plugin/tabcat.plugin.zsh', import.meta.url));

/** Separator for values that may themselves contain tabs or newlines. */
export const ROW = '<<<ROW>>>';

export const hasZsh = (): boolean => {
  try {
    execFileSync('zsh', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

export interface ZshRun {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Runs a zsh snippet in a pristine interactive shell (`-f -i`): no user rc
 * files, but `[[ -o interactive ]]` holds so the plugin actually loads.
 */
export function runZsh(script: string, options: { args?: readonly string[]; env?: Record<string, string>; cwd?: string } = {}): ZshRun {
  const env: Record<string, string> = {
    // A minimal environment keeps the tests independent of the developer's setup.
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    TERM: 'dumb',
    ...options.env,
  };
  // spawnSync, not execFileSync: the plugin reports conflicts on stderr, and
  // execFileSync only hands stderr back when the command fails.
  const result = spawnSync('zsh', ['-f', '-i', '-c', script, 'tabcat-test', ...(options.args ?? [])], {
    encoding: 'utf8',
    env,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 1 };
}

/**
 * Async twin of runZsh. Required whenever the daemon runs in this process:
 * spawnSync blocks the event loop, so an in-process daemon could never answer
 * while zsh waits for its response — every request would time out.
 */
export function runZshAsync(
  script: string,
  options: { args?: readonly string[]; env?: Record<string, string>; cwd?: string } = {},
): Promise<ZshRun> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/tmp',
    TERM: 'dumb',
    ...options.env,
  };
  return new Promise((resolve) => {
    const child = spawn('zsh', ['-f', '-i', '-c', script, 'tabcat-test', ...(options.args ?? [])], {
      env,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (status) => resolve({ stdout, stderr, status: status ?? 1 }));
  });
}

/** Sources the plugin without running setup — for testing single functions. */
export const withPlugin = (body: string): string =>
  `TABCAT_PLUGIN_NO_SETUP=1 source ${PLUGIN_FILE}\n${body}`;

/** Sources the plugin AND runs setup — for testing bindings and hooks. */
export const withPluginSetup = (body: string): string => `source ${PLUGIN_FILE}\n${body}`;

export const pluginExists = (): boolean => existsSync(PLUGIN_FILE);

/** Splits ROW-delimited output back into the original values. */
export const splitRows = (stdout: string): string[] => stdout.split(ROW).slice(0, -1);
