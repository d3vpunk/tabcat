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
  /** Interactive invocation: writes aliases + functions as re-sourceable code to a file. */
  snapshotArgs(outputFile: string): string[];
  /** Non-interactive invocation (no rc files) for the wrapped script. */
  execArgs(script: string): string[];
  /**
   * Line(s) BEFORE the snapshot aliases in the exec script. bash only expands
   * aliases in non-interactive shells with expand_aliases; zsh needs nothing.
   */
  readonly execPreamble: string;
  /**
   * Shell code that loads tabcat's recent commands (written to `historyFile`,
   * one per line) into the exec shell so `history` / `fc` / oh-my-zsh's
   * `omz_history` work — the isolated one-shot shell otherwise has an empty
   * event list and `fc` errors with "no such event".
   */
  historyPreamble(historyFile: string, size: number): string;
  defaultHistoryPath(homeDir: string): string;
  parseHistory(content: string, cwd: string | null, fallbackTs: number): HistoryEntry[];
}

export const zshShell: ShellAdapter = {
  name: 'zsh',
  file: 'zsh',
  // Interactive shell so rc aliases + functions exist. `alias -L` dumps
  // aliases as `alias name='...'`; the loop dumps every non-underscore
  // function (skip completion/internal `_*` to keep the snapshot lean).
  // oh-my-zsh wraps commands like `history` in a function (`history=omz_history`)
  // — without the function bodies the alias breaks with "command not found".
  snapshotArgs: (outputFile) => {
    const out = quote(outputFile);
    // Functions FIRST, aliases after. zsh refuses to define a function whose
    // name is currently an alias — and `run-help` is both a built-in default
    // alias and a routinely autoloaded function. With the aliases up front,
    // that collision aborts the parse and EVERY later definition in the file
    // is silently lost.
    return ['-ic', `for fn in \${(k)functions:#_*}; do typeset -f -- "$fn"; done > ${out}; alias -L >> ${out}`];
  },
  execArgs: (script) => ['-fc', script],
  // `zsh -f` still carries its built-in aliases (`run-help`, `which-command`),
  // so the snapshot's function definitions for those very names would fail to
  // parse. Dropping them first costs nothing: the snapshot re-declares every
  // alias the interactive shell had, these two included. Silent when nothing
  // matches, which matters because the exec shell inherits stdio.
  execPreamble: "unalias -m '*'",
  historyPreamble: (historyFile, size) => `HISTSIZE=${size}; fc -R ${quote(historyFile)} 2>/dev/null || true`,
  defaultHistoryPath: (homeDir) => `${homeDir}/.zsh_history`,
  parseHistory: parseZshHistory,
};

export const bashShell: ShellAdapter = {
  name: 'bash',
  file: 'bash',
  // `alias -p`: same `alias name='...'` format as zsh's `alias -L`. `declare -f`
  // dumps function bodies; the loop skips completion/internal `_*` functions so
  // the snapshot stays lean and function-backed commands keep working.
  snapshotArgs: (outputFile) => {
    const out = quote(outputFile);
    return ['-ic', `alias -p > ${out}; for fn in $(declare -F | awk '{print $3}'); do [[ $fn == _* ]] || declare -f "$fn"; done >> ${out}`];
  },
  execArgs: (script) => ['-c', script],
  execPreamble: 'shopt -s expand_aliases',
  historyPreamble: (historyFile, size) =>
    `set -o history; HISTSIZE=${size}; history -r ${quote(historyFile)} 2>/dev/null || true`,
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
