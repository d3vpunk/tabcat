import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellAdapter, detectShell } from '../engine/shell.js';

export interface ExecutionResult {
  cwd: string;
  exitCode: number;
}

/**
 * How many recent commands are loaded into each exec shell for `history`/`fc`.
 * Capped so a large learned history does not cost a full write per command —
 * `history` shows the recent tail anyway.
 */
export const SEED_HISTORY_ENTRIES = 1000;

export interface ShellSnapshot {
  /** Path to a file with re-sourceable aliases + functions from the login rc. */
  file: string;
  /** Removes the snapshot's temp dir. Call once on REPL shutdown. */
  cleanup: () => void;
}

/**
 * Captures the login shell's aliases and functions into a re-sourceable file
 * asynchronously. The REPL waits for the snapshot before the first EXECUTE (not
 * before the first prompt): the race "command runs without aliases because the
 * snapshot is still loading" is gone, without blocking the first prompt.
 *
 * The file is kept for the whole session and `source`d per command (rather than
 * inlined into every exec string — the dump is tens of KB). null = no snapshot
 * (no shell, rc broken, timeout); the caller should warn. RC output on stdout
 * is ignored — only the explicit snapshot file is later used as shell code.
 */
export function warmShellSnapshot(
  shell: ShellAdapter = detectShell(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShellSnapshot | null> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'tabcat-snapshot-'));
    const file = join(dir, 'snapshot');
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve({ file, cleanup });
    };

    // detached: the interactive shell gets its own session WITHOUT a controlling
    // TTY — otherwise its job control grabs the terminal and the REPL
    // stdin read dies with EIO.
    const child = spawn(shell.file, shell.snapshotArgs(file), {
      detached: true,
      stdio: 'ignore',
      env,
    });
    // A hanging .zshrc must not block the REPL forever.
    const timer = setTimeout(() => {
      child.kill();
      fail();
    }, 15_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return fail();
      // The snapshot must at least have been written (may be empty: no aliases
      // and no functions is legitimate).
      try {
        statSync(file);
        succeed();
      } catch {
        fail();
      }
    });
    child.on('error', () => {
      // Shell not installed? Then we go without aliases.
      clearTimeout(timer);
      fail();
    });
    child.unref();
  });
}

/**
 * Executes the line non-interactively (without rc files); stdio inherit lets
 * interactive tools (vim, ssh) run natively. The snapshot file (aliases +
 * functions) is `source`d first, then the user line runs through `eval` so the
 * aliases take effect (the shell expands aliases at parse time — in the same
 * -c string they would no longer hit the already-parsed line).
 *
 * cwd persistence: the child process writes its $PWD to a temp file at the end.
 * This way combined lines like `cd x && make` also affect the REPL cwd.
 *
 * `history` holds tabcat's recent commands (chronological, oldest first). They
 * are written to a temp file and loaded into the exec shell so `history`/`fc`
 * reflect the session — the one-shot shell has no event list of its own.
 */
/**
 * Collapses a history entry to one physical line for the exec shell's seed
 * file: a multiline command (paste mode) would otherwise split into bogus
 * history events. Continuation backslashes join into the same command,
 * remaining real newlines separate commands — `;` keeps the collapsed line
 * valid shell if it is ever recalled via `!!`/`fc`.
 */
export function seedLine(entry: string): string {
  return entry.replace(/\s*\\\n\s*/g, ' ').replace(/\s*\n\s*/g, '; ');
}

export function execute(
  line: string,
  cwd: string,
  shell: ShellAdapter = detectShell(),
  snapshotFile = '',
  history: readonly string[] = [],
): ExecutionResult {
  const dir = mkdtempSync(join(tmpdir(), 'tabcat-'));
  const pwdFile = join(dir, 'pwd');

  let historyLoad = '';
  if (history.length > 0) {
    const seed = history.slice(-SEED_HISTORY_ENTRIES).map(seedLine);
    const histFile = join(dir, 'history');
    // 0600: the file holds command history — same sensitivity as the store.
    writeFileSync(histFile, `${seed.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    historyLoad = shell.historyPreamble(histFile, seed.length);
  }

  const wrapped = [
    shell.execPreamble,
    snapshotFile !== '' ? `source ${quote(snapshotFile)}` : '',
    historyLoad,
    `eval ${quote(line)}`,
    '__tabcat_rc=$?',
    `pwd > ${quote(pwdFile)}`,
    'exit $__tabcat_rc',
  ]
    .filter((part) => part !== '')
    .join('\n');

  const result = spawnSync(shell.file, shell.execArgs(wrapped), { cwd, stdio: 'inherit' });

  if (result.error) {
    // Shell missing/not startable — otherwise the error would sit silently in the exit code.
    console.error(`tabcat: ${shell.file} could not be started: ${result.error.message}`);
  }

  let nextCwd = cwd;
  try {
    const captured = readFileSync(pwdFile, 'utf8').trim();
    if (captured !== '') nextCwd = captured;
  } catch {
    // Command terminated the shell early (exec/exit) — cwd stays.
  }
  rmSync(dir, { recursive: true, force: true });

  return { cwd: nextCwd, exitCode: exitCodeOf(result.status, result.signal) };
}

/**
 * Signal death (status null) must be mapped to the shell convention 128+signal
 * number — otherwise a Ctrl-C kill (SIGINT -> 130) would be learned as
 * success (0) and poison the prediction.
 */
function exitCodeOf(status: number | null, signal: NodeJS.Signals | null): number {
  if (status !== null) return status;
  if (signal !== null) return 128 + (constants.signals[signal] ?? 0);
  return 1; // process never started at all (result.error above)
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
