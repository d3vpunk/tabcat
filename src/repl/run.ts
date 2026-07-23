import { homedir } from 'node:os';
import { HistoryEntry } from '../engine/model.js';
import { MagicName, NameIndex } from '../engine/names.js';
import { appendName, namesFileFor, readNames } from '../engine/names-store.js';
import { Predictor } from '../engine/predictor.js';
import { detectShell } from '../engine/shell.js';
import { appendHistory, compactHistory, defaultHistoryFile } from '../engine/store.js';
import { VERSION } from '../version.js';
import { ReplOutput, promptOnce, showReplHelp, showReplOutput } from './app.js';
import { ShellSnapshot, execute, warmShellSnapshot } from './executor.js';
import { realFs } from './real-fs.js';
import { showMeowAnimation } from './meow.js';
import { calculateReplStats } from './stats.js';

export interface ReplCommandContext {
  cwd: string;
  historyFile: string;
  entries: readonly HistoryEntry[];
  names?: readonly MagicName[];
  showHelp?: () => void;
  showOutput?: (output: ReplOutput) => void;
  clear?: () => void;
}

export type ReplCommandResult = 'unhandled' | 'handled' | 'meow' | 'exit';

export function handleReplCommand(line: string, context: ReplCommandContext): ReplCommandResult {
  // Colon is the single magic prefix — a leading '/' collides with absolute
  // paths and had no dropdown hints, so ':' is the only recognized form.
  const command = /^:(\w+)$/.exec(line)?.[1];
  const showOutput = context.showOutput ?? showReplOutput;
  switch (command) {
    case 'help':
      (context.showHelp ?? showReplHelp)();
      return 'handled';
    case 'history': {
      const recent = context.entries.slice(-10);
      showOutput({
        kind: 'history',
        entries: recent.map((entry, index) => ({
          number: context.entries.length - recent.length + index + 1,
          line: entry.line,
        })),
      });
      return 'handled';
    }
    case 'stats': {
      showOutput({
        kind: 'stats',
        stats: calculateReplStats(context.entries),
        historyFile: context.historyFile,
      });
      return 'handled';
    }
    case 'names': {
      // Read-only listing — creation and deletion live in the Ctrl+N badge.
      const all = context.names ?? [];
      const isActive = (name: MagicName): boolean => name.cwds.length === 0 || name.cwds.includes(context.cwd);
      const sorted = [...all].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.ts - a.ts);
      showOutput({
        kind: 'names',
        names: sorted.map((name) => ({ name: name.name, line: name.line, active: isActive(name) })),
      });
      return 'handled';
    }
    case 'version':
      showOutput({ kind: 'version', version: VERSION });
      return 'handled';
    case 'cwd':
      showOutput({ kind: 'cwd', cwd: context.cwd });
      return 'handled';
    case 'clear':
      (context.clear ?? (() => process.stdout.write('\x1B[2J\x1B[H')))();
      return 'handled';
    case 'meow':
      return 'meow';
    case 'exit':
      return 'exit';
    default:
      return 'unhandled';
  }
}

/**
 * The REPL loop: smart prompt -> Ink unmounts -> command runs natively ->
 * learn -> next prompt. Seamless shell experience.
 */
export async function runRepl(historyFile: string = defaultHistoryFile()): Promise<void> {
  if (!isInteractiveTerminal(process.stdin, process.stdout)) {
    console.error('tabcat: REPL requires an interactive terminal (TTY).');
    process.exitCode = 1;
    return;
  }

  // Ctrl-C hits the whole foreground process group. Like a real shell,
  // tabcat ignores SIGINT permanently: if a child is running, only the child
  // dies and the prompt comes back. At the prompt itself the terminal is in
  // raw mode — no SIGINT is generated there, Ctrl-C arrives as a character
  // (clears the line). An add/remove per command would be a race: the signal
  // event buffered during spawnSync fires only AFTER removeListener.
  process.on('SIGINT', () => {});

  // Terminal gone (ssh disconnect, closed tab) -> exit cleanly instead of
  // an unhandled EIO from Ink's setRawMode. Don't touch other read errors.
  process.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EIO') process.exit(0);
  });

  // Load aliases asynchronously — the first PROMPT does not block, but before
  // the first EXECUTE we wait for the snapshot (typing time almost always
  // bridges the ~2.6s rc load time).
  const shell = detectShell();
  const snapshotReady = warmShellSnapshot(shell);
  let snapshotChecked = false;
  let snapshot: ShellSnapshot | null = null;
  let snapshotFile = '';
  // Compacts when the cap is exceeded — keeps file and startup time small.
  const entries = compactHistory(historyFile, undefined, (count) => {
    console.error(`tabcat: skipped ${count} invalid history line(s) (${historyFile}).`);
  });
  if (entries.length === 0) {
    // First start: without learned data no dropdown, no ghost — the prompt
    // feels dead. Explain instead of staying silent.
    console.log(
      `tabcat: history empty — \`tabcat import\` seeds from ${shell.defaultHistoryPath(homedir())}, afterwards tabcat learns from every input.`,
    );
  }
  const homeDir = homedir();
  // Magic names: on by default, TABCAT_MAGIC_NAMES=0 makes the whole layer
  // dormant (empty index, predictor unchanged, Ctrl+N no-op).
  const magicEnabled = process.env['TABCAT_MAGIC_NAMES'] !== '0';
  const namesFile = namesFileFor(historyFile);
  const nameIndex = new NameIndex(magicEnabled ? readNames(namesFile) : []);
  const predictor = new Predictor(entries, {
    now: () => Date.now(),
    fs: realFs,
    homeDir,
    ...(magicEnabled ? { names: nameIndex } : {}),
  });
  const historyLines = entries.map((e) => e.line);
  let cwd = process.cwd();
  let lastExitCode: number | undefined;
  let historyWritable = true;

  for (;;) {
    const result = await promptOnce({
      predictor,
      cwd,
      homeDir,
      historyLines,
      lastExitCode,
      ...(magicEnabled ? { names: nameIndex } : {}),
    });
    if (result.type === 'exit') break;

    const line = result.line.trim();
    if (line === '') continue;
    if (line === 'exit') break;
    const replCommand = handleReplCommand(line, { cwd, historyFile, entries, names: nameIndex.all() });
    if (replCommand === 'exit') break;
    if (replCommand === 'meow') {
      await showMeowAnimation();
      continue;
    }
    if (replCommand === 'handled') continue;

    if (!snapshotChecked) {
      snapshotChecked = true;
      snapshot = await snapshotReady;
      if (snapshot === null) {
        console.error(
          `tabcat: alias snapshot failed (${shell.file}) — aliases and functions are not available in this session.`,
        );
      } else {
        snapshotFile = snapshot.file;
      }
    }

    // Naming badge outcome: create/delete BEFORE executing — saving is
    // independent of the command's exit code (a failed command keeps its name).
    if (magicEnabled && result.saveName !== undefined) {
      if (result.saveName === '') {
        // Empty badge on a previously named command = delete (tombstone);
        // on an unnamed one it is just the escape hatch — nothing to do.
        if (nameIndex.has(line)) {
          nameIndex.remove(line);
          appendName(namesFile, { name: '', line, cwds: [], ts: Date.now() });
        }
      } else {
        const magicName: MagicName = { name: result.saveName, line, cwds: [cwd], ts: Date.now() };
        nameIndex.add(magicName);
        appendName(namesFile, magicName);
      }
    }

    // cwd attribution: we learn WHERE the line was typed — not where cd led.
    const typedCwd = cwd;
    // historyLines are the commands BEFORE this one — the exec shell's `history`
    // reflects the session up to (not including) the running command, shell-like.
    const execution = execute(line, cwd, shell, snapshotFile, historyLines);
    cwd = execution.cwd;
    lastExitCode = execution.exitCode;

    const entry = {
      ts: Date.now(),
      cwd: typedCwd,
      line,
      exitCode: execution.exitCode,
      completion: result.completion,
    };
    if (historyWritable) {
      try {
        appendHistory(historyFile, entry);
      } catch (error) {
        historyWritable = false;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`tabcat: history could not be saved (${historyFile}): ${message}`);
        console.error('tabcat: this session continues without further history write attempts.');
      }
    }
    predictor.learn(entry);
    entries.push(entry);
    historyLines.push(line);
  }

  // Session over: drop the snapshot temp file. If the user quit before the
  // first command, the snapshot may still be loading — await it, then clean up.
  (snapshot ?? (await snapshotReady))?.cleanup();
}

export function isInteractiveTerminal(
  input: Pick<NodeJS.ReadStream, 'isTTY'>,
  output: Pick<NodeJS.WriteStream, 'isTTY'>,
): boolean {
  return input.isTTY === true && output.isTTY === true;
}
