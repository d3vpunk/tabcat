import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MAX_SOCKET_PATH, defaultSocketPath } from '../daemon/paths.js';

export const MIN_NODE_MAJOR = 20;
/** `zsocket` and `${(g::)}` both exist from 5.1; older zsh cannot run the plugin. */
export const MIN_ZSH_VERSION = '5.1';

/**
 * Absolute path of the plugin file. Built output lives next to this module in
 * dist/, the checkout has it in src/plugin/ — both are supported so the CLI
 * works via `tsx src/cli.ts` too.
 */
export function pluginFilePath(): string {
  const candidates = [
    new URL('../tabcat.plugin.zsh', import.meta.url),
    new URL('./tabcat.plugin.zsh', import.meta.url),
  ].map((url) => fileURLToPath(url));
  return candidates.find((path) => existsSync(path)) ?? (candidates[0] as string);
}

/** What the user pastes into .zshrc — the starship pattern: one source line. */
export function initSnippet(pluginFile: string = pluginFilePath()): string {
  return `# tabcat — chunk-based, learning autocomplete (tabcat plugin init zsh)
source ${quoteForZsh(pluginFile)}`;
}

export interface CheckDeps {
  run: (command: string, args: readonly string[]) => { status: number; stdout: string };
  readTextFile: (path: string) => string | null;
  env: NodeJS.ProcessEnv;
  home: string;
  nodeVersion: string;
  pluginFile: string;
  pluginFileExists: boolean;
}

export interface CheckLine {
  ok: boolean;
  /** false = worth mentioning but not a blocker (e.g. .zshrc not wired up yet). */
  blocking: boolean;
  text: string;
}

export interface CheckResult {
  ok: boolean;
  lines: CheckLine[];
}

/**
 * Static preflight for `tabcat plugin init zsh --check`. Live conflicts (who
 * owns Tab, which keys are bound, whether zsh-autosuggestions is loaded) can
 * only be seen from inside the user's interactive shell — the plugin itself
 * reports those at load time.
 */
export function checkEnvironment(deps: CheckDeps): CheckResult {
  const lines: CheckLine[] = [];

  const nodeMajor = Number(deps.nodeVersion.split('.')[0]);
  lines.push(
    check(
      Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR,
      true,
      `node ${deps.nodeVersion} (need >= ${MIN_NODE_MAJOR})`,
    ),
  );

  const zsh = deps.run('zsh', ['--version']);
  const zshVersion = zsh.status === 0 ? (zsh.stdout.trim().split(/\s+/)[1] ?? '?') : '';
  lines.push(
    check(
      zshVersion !== '' && compareVersions(zshVersion, MIN_ZSH_VERSION) >= 0,
      true,
      zshVersion === '' ? 'zsh not found' : `zsh ${zshVersion} (need >= ${MIN_ZSH_VERSION})`,
    ),
  );

  const socketModule = deps.run('zsh', ['-fc', 'zmodload zsh/net/socket']);
  lines.push(check(socketModule.status === 0, true, 'zsh/net/socket module available'));

  lines.push(check(deps.pluginFileExists, true, `plugin file ${deps.pluginFile}`));

  const socketPath = defaultSocketPath(deps.env);
  lines.push(
    check(
      socketPath.length <= MAX_SOCKET_PATH,
      true,
      `socket path ${socketPath} (${socketPath.length}/${MAX_SOCKET_PATH} characters)`,
    ),
  );

  const zshrc = deps.readTextFile(`${deps.home}/.zshrc`);
  const sourced = zshrc !== null && zshrc.includes('tabcat.plugin.zsh');
  lines.push(
    check(sourced, false, sourced ? '.zshrc sources the plugin' : '.zshrc does not source the plugin yet'),
  );

  return { ok: lines.every((line) => line.ok || !line.blocking), lines };
}

export function defaultCheckDeps(): CheckDeps {
  const pluginFile = pluginFilePath();
  return {
    run: (command, args) => {
      const result = spawnSync(command, [...args], { encoding: 'utf8' });
      return { status: result.status ?? 1, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    },
    readTextFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    env: process.env,
    home: homedir(),
    nodeVersion: process.versions.node,
    pluginFile,
    pluginFileExists: existsSync(pluginFile),
  };
}

export const formatCheck = (result: CheckResult): string =>
  result.lines.map((line) => `${line.ok ? 'ok  ' : line.blocking ? 'FAIL' : 'note'}  ${line.text}`).join('\n');

const check = (ok: boolean, blocking: boolean, text: string): CheckLine => ({ ok, blocking, text });

/** Single-quoted unless the path is boring — keeps spaces in a home directory safe. */
const quoteForZsh = (path: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
