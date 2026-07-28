import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MAX_SOCKET_PATH, resolveSocketPath, socketPathLength } from '../daemon/paths.js';
import { VERSION } from '../version.js';

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
  /** Command the plugin spawns — `tabcat` unless TABCAT_BIN says otherwise. */
  binary: string;
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

  // The plugin starts whatever `tabcat` PATH resolves to — not this build. An
  // older install without the `daemon` command is the failure that looks like a
  // broken plugin: every spawn fails and the plugin disables itself. A version
  // comparison would not catch it (both can report the same version), so ask
  // the binary whether it knows the command.
  const presence = deps.run(deps.binary, ['--version']);
  const pathVersion = presence.status === 0 ? (presence.stdout.trim().split('\n').pop() ?? '').trim() : '';
  if (pathVersion === '') {
    lines.push(check(false, true, `${deps.binary} not found in PATH (the plugin spawns it to start the daemon)`));
  } else {
    const probe = deps.run(deps.binary, ['daemon', 'status']);
    const supportsDaemon = !probe.stdout.includes('Unknown command');
    lines.push(
      check(
        supportsDaemon,
        true,
        supportsDaemon
          ? `${deps.binary} in PATH is ${pathVersion} and supports \`daemon\``
          : `${deps.binary} in PATH is ${pathVersion} and has no \`daemon\` command — the plugin cannot start a daemon (run \`npm link\` in the checkout, or npm i -g the new version)`,
      ),
    );
    if (supportsDaemon && pathVersion !== VERSION) {
      lines.push(
        check(false, false, `${deps.binary} in PATH is ${pathVersion}, this build is ${VERSION} — the plugin uses the one in PATH`),
      );
    }
  }

  // The effective path, not the computed default: with $TABCAT_SOCKET set, the
  // check would otherwise report a socket nobody uses.
  const socketPath = resolveSocketPath(undefined, deps.env);
  const socketBytes = socketPathLength(socketPath);
  lines.push(
    check(
      socketBytes <= MAX_SOCKET_PATH,
      true,
      `socket path ${socketPath} (${socketBytes}/${MAX_SOCKET_PATH} bytes)`,
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
    binary: process.env['TABCAT_BIN'] ?? 'tabcat',
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
