import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { HistoryEntry } from './model.js';
import { parseZshHistory } from './zsh-import.js';
import { parseBashHistory } from './bash-import.js';

/**
 * Shell adapter: everything shell-specific (alias snapshot, exec invocation,
 * history location + format) behind one interface — the rest of the tool is
 * shell-neutral. Deliberately only zsh and bash are supported.
 */
export interface ShellAdapter {
  readonly name: 'zsh' | 'bash';
  /** Program name for spawn/spawnSync. */
  readonly file: string;
  /** Interactive invocation: writes aliases as executable commands to a file. */
  snapshotArgs(outputFile: string): string[];
  /** Non-interactive invocation (no rc files) for the wrapped script. */
  execArgs(script: string): string[];
  /**
   * Line(s) BEFORE the snapshot aliases in the exec script. bash only expands
   * aliases in non-interactive shells with expand_aliases; zsh needs nothing.
   */
  readonly execPreamble: string;
  defaultHistoryPath(homeDir: string): string;
  parseHistory(content: string, cwd: string | null, fallbackTs: number): HistoryEntry[];
}

export const zshShell: ShellAdapter = {
  name: 'zsh',
  file: 'zsh',
  // -L: aliases as `alias name='...'` (machine-readable, reusable).
  snapshotArgs: (outputFile) => ['-ic', `alias -L > ${quote(outputFile)}`],
  execArgs: (script) => ['-fc', script],
  execPreamble: '',
  defaultHistoryPath: (homeDir) => `${homeDir}/.zsh_history`,
  parseHistory: parseZshHistory,
};

export const bashShell: ShellAdapter = {
  name: 'bash',
  file: 'bash',
  // -p: same output format as zsh's `alias -L` — the preamble is
  // directly executable for both shells.
  snapshotArgs: (outputFile) => ['-ic', `alias -p > ${quote(outputFile)}`],
  execArgs: (script) => ['-c', script],
  execPreamble: 'shopt -s expand_aliases',
  defaultHistoryPath: (homeDir) => `${homeDir}/.bash_history`,
  parseHistory: parseBashHistory,
};

/**
 * Uses a supported login shell if it is installed. On missing/unknown $SHELL
 * or missing binary, tabcat falls back to an available supported shell.
 * Other shells are never executed.
 */
export function detectShell(
  env: NodeJS.ProcessEnv = process.env,
  isAvailable: (file: string) => boolean = shellAvailable,
): ShellAdapter {
  const configured = shellFromPath(env['SHELL']);
  const candidates = configured
    ? [configured, configured === bashShell ? zshShell : bashShell]
    : [bashShell, zshShell];

  const available = candidates.find((shell) => isAvailable(shell.file));
  // Spawn via the absolute binary path, not the bare name: the child's PATH is
  // not guaranteed to contain the shell's directory (launched from a GUI, a
  // stripped env, a non-login context), which surfaced as `spawnSync zsh ENOENT`
  // at command time even though startup detection had passed.
  if (available) return { ...available, file: resolveShellPath(available, env) };

  const configuredHint = env['SHELL'] ? ` ($SHELL=${env['SHELL']})` : '';
  throw new Error(`No supported shell found${configuredHint}. tabcat requires bash or zsh in PATH.`);
}

/**
 * Absolute path to the shell binary: prefer $SHELL when it points at this very
 * shell, then search PATH and the well-known install locations. Falls back to
 * the bare name (spawn resolves it against PATH at run time) so behavior is
 * never worse than before.
 */
export function resolveShellPath(
  shell: ShellAdapter,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = isExecutableFile,
): string {
  const configured = env['SHELL'];
  if (configured && configured.split('/').at(-1) === shell.name && exists(configured)) {
    return configured;
  }
  const dirs = [
    ...(env['PATH']?.split(':').filter(Boolean) ?? []),
    '/bin',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  for (const dir of dirs) {
    const full = `${dir}/${shell.name}`;
    if (exists(full)) return full;
  }
  return shell.name;
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function shellFromPath(path: string | undefined): ShellAdapter | undefined {
  const name = path?.split('/').at(-1);
  if (name === 'bash') return bashShell;
  if (name === 'zsh') return zshShell;
  return undefined;
}

function shellAvailable(file: string): boolean {
  return spawnSync(file, ['--version'], { stdio: 'ignore' }).error === undefined;
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
