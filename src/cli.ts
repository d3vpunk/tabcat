#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { CliArgumentError, commandUsage, parseCliArgs } from './cli-args.js';
import { HistoryEntry } from './engine/model.js';
import { Predictor } from './engine/predictor.js';
import { detectShell } from './engine/shell.js';
import { namesFileFor, readNames } from './engine/names-store.js';
import { MAX_HISTORY_ENTRIES, appendHistory, dedupeImportEntries, defaultHistoryFile, readHistory } from './engine/store.js';
import { AlreadyRunningError, startDaemon } from './daemon/server.js';
import { pingDaemon, shutdownDaemon } from './daemon/client.js';
import { SocketPathError, resolveSocketPath } from './daemon/paths.js';
import { PROTOCOL_VERSION } from './daemon/protocol.js';
import { checkEnvironment, defaultCheckDeps, formatCheck, initSnippet, pluginFilePath } from './plugin/init.js';
import { realFs } from './repl/real-fs.js';
import { VERSION } from './version.js';


const isAddressInUse = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'EADDRINUSE';

const readHistoryWithWarning = (file: string): HistoryEntry[] =>
  readHistory(file, (count) => console.error(`tabcat: skipped ${count} invalid history line(s) (${file}).`));

function printHelp(): void {
  console.log(`tabcat ${VERSION} — chunk-based, learning shell autocomplete

Usage: tabcat [command] [options]

Commands:
  repl (default)  Start smart prompt
  import          Seed from shell history (zsh/bash, detected via $SHELL) [--file <path>]
  simulate        Show ranking for a line: --line <str> [--cwd <dir>] [--now <ms>] [--json]
  stats           History overview (entries, directories)
  names           List magic names (Ctrl-N shortcuts from the REPL)
  daemon          Run the prediction daemon for the zsh plugin (status|stop|path)
  plugin init zsh Print the .zshrc snippet for the zsh plugin [--check]
  help            This help

Options:
  --history <path>  Alternative history path (default: ~/.config/tabcat/history.jsonl)
  --socket <path>   Alternative daemon socket (default: $XDG_RUNTIME_DIR/tabcat/daemon.sock)
  --minimal         Compact prompt (repl): 1-row dropdown, no legend line
  --json            Machine-readable output (simulate)
  --version         Print version

Options may appear before or after the command. Command help: tabcat <command> --help

Note: Each command runs in an isolated shell. The working directory
persists; exported variables, functions, and new aliases do not.`);
}

let args;
try {
  args = parseCliArgs(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof CliArgumentError)) throw error;
  console.error(`tabcat: ${error.message}`);
  const known = ['repl', 'import', 'simulate', 'stats', 'names', 'daemon', 'plugin'] as const;
  const commandHint = process.argv.slice(2).find((token) => (known as readonly string[]).includes(token));
  console.error(commandUsage(error.command ?? (commandHint as (typeof known)[number] | undefined) ?? 'help'));
  process.exit(2);
}

if (args.commandHelp) {
  console.log(commandUsage(args.command));
  process.exit(0);
}

switch (args.command) {
  case 'help':
    printHelp();
    break;

  case 'version': {
    console.log(VERSION);
    break;
  }

  case 'simulate': {
    const historyFile = args.history ?? defaultHistoryFile();
    const line = args.line ?? '';
    const cwd = args.cwd ?? process.cwd();
    const now = args.now ?? Date.now();

    // Like the REPL: learn only the most recent N entries (startup-time cap).
    const entries = readHistoryWithWarning(historyFile).slice(-MAX_HISTORY_ENTRIES);
    const predictor = new Predictor(entries, { now: () => now, fs: realFs, homeDir: homedir() });
    const prediction = predictor.predict({ line, cursor: line.length, cwd });

    if (args.json === true) {
      // Machine-readable twin of the human output — for scripting, CI checks
      // and bug reports; no daemon involved.
      console.log(
        JSON.stringify({
          entries: entries.length,
          line,
          cwd,
          prefix: prediction.prefix,
          candidates: prediction.candidates,
        }),
      );
      break;
    }

    console.log(`history: ${entries.length} entries | line: "${line}" | prefix: "${prediction.prefix}"`);
    if (prediction.candidates.length === 0) {
      console.log('(no candidates)');
      break;
    }
    prediction.candidates.forEach((c, i) => {
      const marker = i === 0 ? '→' : ' ';
      console.log(`${marker} [${c.source.padEnd(7)}] ${c.score.toFixed(3).padStart(9)}  insert: "${c.insert}"`);
    });
    break;
  }

  case 'import': {
    const shell = detectShell();
    const source = args.file ?? shell.defaultHistoryPath(homedir());
    const target = args.history ?? defaultHistoryFile();
    if (!existsSync(source)) {
      console.error(`Source not found: ${source}`);
      process.exit(1);
    }
    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
    const entries = shell.parseHistory(readFileSync(source, 'utf8'), null, thirtyDaysAgo);

    // Dedup against the existing history and within the source. Timestamped
    // entries key on (ts, line); parser-stamped fallback entries (plain
    // history) key on the line alone so re-imports stay idempotent.
    const fresh = dedupeImportEntries(readHistoryWithWarning(target), entries, thirtyDaysAgo);
    for (const entry of fresh) appendHistory(target, entry);
    console.log(`Imported ${fresh.length} new entries (${entries.length - fresh.length} duplicates skipped) into ${target}`);
    break;
  }

  case 'stats': {
    const historyFile = args.history ?? defaultHistoryFile();
    const entries = readHistoryWithWarning(historyFile);
    const byCwd = new Map<string, number>();
    for (const entry of entries) {
      if (entry.cwd !== null) byCwd.set(entry.cwd, (byCwd.get(entry.cwd) ?? 0) + 1);
    }
    console.log(`${entries.length} entries, ${byCwd.size} directories (${historyFile})`);
    break;
  }

  case 'names': {
    const historyFile = args.history ?? defaultHistoryFile();
    const names = readNames(namesFileFor(historyFile));
    if (names.length === 0) {
      console.log('No magic names yet — press Ctrl-N on a typed command in the REPL to create one.');
      break;
    }
    const width = Math.max(...names.map((name) => name.name.length));
    for (const name of names) console.log(`${name.name.padEnd(width)}  ${name.line}`);
    break;
  }

  case 'daemon': {
    const historyFile = args.history ?? defaultHistoryFile();
    const socketPath = resolveSocketPath(args.socket);
    const sub = args.subs[0];

    // Exists so other front ends (the macOS overlay, any script) do not have to
    // reimplement the sun_path rule a third time — the zsh plugin already
    // mirrors it. Pure output: no daemon contact, no directory created.
    if (sub === 'path') {
      console.log(socketPath);
      break;
    }

    if (sub === 'status') {
      const info = await pingDaemon(socketPath, 1_000);
      if (info === null) {
        console.log(`not running (socket ${socketPath})`);
        process.exitCode = 1;
        break;
      }
      console.log(
        `running: version ${info.version}, protocol ${info.protocol}, state ${info.state}, pid ${info.pid} (socket ${socketPath})`,
      );
      if (info.protocol !== PROTOCOL_VERSION) {
        console.log(`warning: this CLI speaks protocol ${PROTOCOL_VERSION} — restart the daemon with \`tabcat daemon stop\``);
      }
      break;
    }

    if (sub === 'stop') {
      if (await shutdownDaemon(socketPath, 2_000)) console.log(`stopped (socket ${socketPath})`);
      else {
        console.log(`not running (socket ${socketPath})`);
        process.exitCode = 1;
      }
      break;
    }

    let handle;
    try {
      handle = await startDaemon({
        socketPath,
        historyFile,
        fs: realFs,
        homeDir: homedir(),
        magicNames: process.env['TABCAT_MAGIC_NAMES'] !== '0',
        onWarn: (message) => console.error(`tabcat: ${message}`),
      });
    } catch (error) {
      if (error instanceof AlreadyRunningError || isAddressInUse(error)) {
        // The desired end state (a daemon is listening) already holds — the
        // plugin races several shells into this on purpose, and two of them can
        // pass the stale-socket probe before either has bound.
        console.error(`tabcat: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      if (error instanceof SocketPathError) {
        // A Node stack trace during shell startup reads like a crash.
        console.error(`tabcat: ${error.message}`);
        process.exitCode = 1;
        break;
      }
      throw error;
    }
    console.error(`tabcat: daemon listening on ${handle.socketPath} (history ${historyFile})`);
    const stop = (): void => void handle.close();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // Survive the terminal that spawned it: the daemon is shared by all shells.
    process.on('SIGHUP', () => {});
    await handle.ready;
    await handle.closed;
    break;
  }

  case 'plugin': {
    if (args.check === true) {
      const result = checkEnvironment(defaultCheckDeps());
      console.log(formatCheck(result));
      if (!result.ok) process.exitCode = 1;
      break;
    }
    const pluginFile = pluginFilePath();
    if (!existsSync(pluginFile)) {
      console.error(`tabcat: plugin file not found: ${pluginFile}`);
      console.error('tabcat: run `npm run build` in a checkout, or reinstall the package.');
      process.exitCode = 1;
      break;
    }
    console.log(initSnippet(pluginFile));
    break;
  }

  case 'repl': {
    // Imported on demand: the REPL pulls in Ink and React, which cost ~250 ms
    // of module loading. `tabcat daemon` is started from a keystroke path and
    // must not pay for a UI it never renders.
    const { runRepl } = await import('./repl/run.js');
    await runRepl(args.history ?? defaultHistoryFile(), { minimal: args.minimal ?? false });
    break;
  }
}
