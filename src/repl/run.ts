import { homedir } from 'node:os';
import { HistoryEntry } from '../engine/model.js';
import { MagicName, NameIndex } from '../engine/names.js';
import { appendName, namesFileFor, readNames } from '../engine/names-store.js';
import { Predictor } from '../engine/predictor.js';
import { detectShell } from '../engine/shell.js';
import { appendHistory, compactHistory, defaultHistoryFile } from '../engine/store.js';
import { SETTINGS, parseInput, specFor } from '../settings/schema.js';
import { boolSetting, clearSetting, intSetting, readSettings, settingsFileFor, writeSetting } from '../settings/store.js';
import { VERSION } from '../version.js';
import { ReplOutput, promptOnce, showReplHelp, showReplOutput } from './app.js';
import { ShellSnapshot, execute, warmShellSnapshot } from './executor.js';
import { osc7Cwd } from './osc.js';
import { realFs } from './real-fs.js';
import { showMeowAnimation } from './meow.js';
import { showSettingsEditor } from './settings-ui.js';
import { calculateReplStats } from './stats.js';

export interface ReplCommandContext {
  cwd: string;
  historyFile: string;
  entries: readonly HistoryEntry[];
  names?: readonly MagicName[];
  /** Called after `:settings` wrote the file — the loop re-reads and the next prompt renders with the new values. */
  onSettingsChanged?: () => void;
  showHelp?: () => void;
  showOutput?: (output: ReplOutput) => void;
  clear?: () => void;
}

export type ReplCommandResult = 'unhandled' | 'handled' | 'meow' | 'settings-ui' | 'exit';

export function handleReplCommand(line: string, context: ReplCommandContext): ReplCommandResult {
  // Colon is the single magic prefix — a leading '/' collides with absolute
  // paths and had no dropdown hints, so ':' is the only recognized form.
  const parsed = /^:(\w+)(?:\s+(\S.*))?$/.exec(line);
  const command = parsed?.[1];
  const rest = parsed?.[2];
  // Only `:settings` takes arguments. `:help foo` stays unhandled (and fails
  // in the shell) exactly as before — no silent reinterpretation.
  if (rest !== undefined && command !== 'settings') return 'unhandled';
  const showOutput = context.showOutput ?? showReplOutput;
  switch (command) {
    case 'settings':
      return handleSettingsCommand(rest, context, showOutput);
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
 * Bare `:settings` — interactive editor (the loop runs it as its own Ink
 * session), `:settings list` — static table, `:settings <key>` — show one,
 * `:settings <key> <value>` — set, `:settings reset <key>` — back to the
 * default. Same schema, same validation, same file as `tabcat settings`; the
 * key/value completion in the dropdown comes from settingsHints (app.tsx).
 */
function handleSettingsCommand(
  rest: string | undefined,
  context: ReplCommandContext,
  showOutput: (output: ReplOutput) => void,
): 'handled' | 'settings-ui' {
  const file = settingsFileFor(context.historyFile);
  const note = (lines: string[], error = false): 'handled' => {
    showOutput({ kind: 'note', title: 'settings', lines, ...(error ? { error } : {}) });
    return 'handled';
  };
  const tokens = rest === undefined ? [] : rest.split(/\s+/);
  const [first, second, ...extra] = tokens;

  if (first === undefined) return 'settings-ui';

  if (first === 'list' && second === undefined) {
    const current = readSettings(file);
    showOutput({
      kind: 'settings',
      rows: SETTINGS.map((spec) => ({
        key: spec.key,
        value: String(current.values.get(spec.key)),
        isDefault: !current.overridden.has(spec.key),
        live: spec.appliesLive,
        description: spec.description,
      })),
    });
    return 'handled';
  }

  if (first === 'reset') {
    if (second === undefined || extra.length > 0) return note(['usage: :settings reset <key>'], true);
    const spec = specFor(second);
    if (spec === undefined) return note([`unknown setting: ${second}`], true);
    try {
      clearSetting(file, second);
    } catch (error) {
      return note([error instanceof Error ? error.message : String(error)], true);
    }
    context.onSettingsChanged?.();
    return note([`${second} = ${spec.default} (default)`]);
  }

  const spec = specFor(first);
  if (spec === undefined) return note([`unknown setting: ${first} — :settings lists all keys`], true);

  if (second === undefined) {
    const current = readSettings(file);
    const suffix = current.overridden.has(first) ? '' : ' (default)';
    return note([`${first} = ${current.values.get(first)}${suffix}`, spec.description]);
  }

  const value = parseInput(spec, [second, ...extra].join(' '));
  if (!value.ok) return note([`${first}: ${value.error}`], true);
  try {
    writeSetting(file, first, value.value);
  } catch (error) {
    return note([error instanceof Error ? error.message : String(error)], true);
  }
  context.onSettingsChanged?.();
  return note([`${first} = ${value.value}${spec.appliesLive ? '' : ' — takes effect at the next start'}`]);
}

export interface ReplOptions {
  /** Compact prompt: 1-row dropdown with inline counter, no legend line. */
  minimal?: boolean;
}

/**
 * The REPL loop: smart prompt -> Ink unmounts -> command runs natively ->
 * learn -> next prompt. Seamless shell experience.
 */
export async function runRepl(historyFile: string = defaultHistoryFile(), options: ReplOptions = {}): Promise<void> {
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
  // Multiline entries (verbatim paste-mode submits) never feed prediction:
  // the single-line dropdown/ghost cannot render them and a collapsed variant
  // would corrupt `\`-continued commands. They stay in the history file and
  // the exec-shell seed only.
  const predictor = new Predictor(entries.filter((entry) => !entry.line.includes('\n')), {
    now: () => Date.now(),
    fs: realFs,
    homeDir,
    ...(magicEnabled ? { names: nameIndex } : {}),
  });
  const historyLines = entries.map((e) => e.line);
  let cwd = process.cwd();
  let lastExitCode: number | undefined;
  let historyWritable = true;
  // Settings are re-read after every `:settings` write — the next prompt
  // renders with the new values, no restart. Warnings print once at startup.
  const settingsFile = settingsFileFor(historyFile);
  let settings = readSettings(settingsFile);
  for (const warning of settings.warnings) console.error(`tabcat: ${warning}`);

  for (;;) {
    // Report the cwd to the terminal (OSC 7) at every prompt — the shell
    // integration that would normally do this is not running inside the REPL.
    // Without it, "new tab in same directory" (Ghostty, iTerm2, Terminal.app)
    // falls back to $HOME.
    process.stdout.write(osc7Cwd(cwd));
    const result = await promptOnce({
      predictor,
      cwd,
      homeDir,
      historyLines,
      lastExitCode,
      minimal: options.minimal ?? false,
      dropdownRows: intSetting(settings, 'repl.dropdownRows'),
      footer: boolSetting(settings, 'repl.footer'),
      ...(magicEnabled
        ? {
            names: nameIndex,
            // ^X inside the prompt: same tombstone semantics as an emptied
            // naming badge, but without executing anything.
            onForget: (forgotten: string) => {
              if (!nameIndex.has(forgotten)) return;
              nameIndex.remove(forgotten);
              appendName(namesFile, { name: '', line: forgotten, cwds: [], ts: Date.now() });
            },
          }
        : {}),
    });
    if (result.type === 'exit') break;

    const line = result.line.trim();
    if (line === '') continue;
    if (line === 'exit') break;
    const replCommand = handleReplCommand(line, {
      cwd,
      historyFile,
      entries,
      names: nameIndex.all(),
      onSettingsChanged: () => {
        settings = readSettings(settingsFile);
      },
    });
    if (replCommand === 'exit') break;
    if (replCommand === 'meow') {
      await showMeowAnimation();
      continue;
    }
    if (replCommand === 'settings-ui') {
      // Own Ink session between two prompts, meow-style. The editor writes
      // through on every change; re-reading here makes the next prompt
      // render with whatever it left behind.
      await showSettingsEditor(settingsFile);
      settings = readSettings(settingsFile);
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
