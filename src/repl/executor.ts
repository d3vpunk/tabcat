import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellAdapter, detectShell } from '../engine/shell.js';

export interface ExecutionResult {
  cwd: string;
  exitCode: number;
}

/**
 * Loads the alias snapshot asynchronously. The returned promise resolves with
 * the session-specific alias preamble — the REPL waits for the snapshot before
 * the first EXECUTE (not before the first prompt): the race
 * "command runs without aliases because the snapshot is still loading" is gone,
 * without blocking the first prompt. null = no snapshot (no zsh, rc
 * broken, timeout) — the caller should warn.
 * RC output on stdout is ignored; only the explicit alias file is
 * later used as shell code.
 */
export function warmShellSnapshot(
  shell: ShellAdapter = detectShell(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'tabcat-aliases-'));
    const aliasFile = join(dir, 'aliases');
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      rmSync(dir, { recursive: true, force: true });
      resolve(value);
    };

    // detached: the interactive shell gets its own session WITHOUT a controlling
    // TTY — otherwise its job control grabs the terminal and the REPL
    // stdin read dies with EIO.
    const child = spawn(shell.file, shell.snapshotArgs(aliasFile), {
      detached: true,
      stdio: 'ignore',
      env,
    });
    // A hanging .zshrc must not block the REPL forever.
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 15_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      try {
        finish(readFileSync(aliasFile, 'utf8'));
      } catch {
        finish(null);
      }
    });
    child.on('error', () => {
      // Shell not installed? Then we go without aliases.
      clearTimeout(timer);
      finish(null);
    });
    child.unref();
  });
}

/**
 * Executes the line non-interactively (without rc files); stdio inherit lets
 * interactive tools (vim, ssh) run natively. The user line runs through
 * `eval` so the snapshot aliases take effect (the shell expands aliases
 * at parse time — in the same -c string they would no longer hit the
 * already-parsed line).
 *
 * cwd persistence: the child process writes its $PWD to a temp file at the end.
 * This way combined lines like `cd x && make` also affect the REPL cwd.
 */
export function execute(
  line: string,
  cwd: string,
  shell: ShellAdapter = detectShell(),
  aliasPreamble = '',
): ExecutionResult {
  const dir = mkdtempSync(join(tmpdir(), 'tabcat-'));
  const pwdFile = join(dir, 'pwd');

  const wrapped = [
    shell.execPreamble,
    aliasPreamble,
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
