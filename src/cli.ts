#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { CliArgumentError, commandUsage, parseCliArgs } from './cli-args.js';
import { HistoryEntry } from './engine/model.js';
import { Predictor } from './engine/predictor.js';
import { detectShell } from './engine/shell.js';
import { MAX_HISTORY_ENTRIES, appendHistory, dedupeImportEntries, defaultHistoryFile, readHistory } from './engine/store.js';
import { realFs } from './repl/real-fs.js';
import { runRepl } from './repl/run.js';
import { VERSION } from './version.js';


const readHistoryWithWarning = (file: string): HistoryEntry[] =>
  readHistory(file, (count) => console.error(`tabcat: skipped ${count} invalid history line(s) (${file}).`));

function printHelp(): void {
  console.log(`tabcat ${VERSION} — chunk-based, learning shell autocomplete

Usage: tabcat [command] [options]

Commands:
  repl (default)  Start smart prompt
  import          Seed from shell history (zsh/bash, detected via $SHELL) [--file <path>]
  simulate        Show ranking for a line: --line <str> [--cwd <dir>] [--now <ms>]
  stats           History overview (entries, directories)
  help            This help

Options:
  --history <path>  Alternative history path (default: ~/.config/tabcat/history.jsonl)
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
  const commandHint = process.argv.slice(2).find((token) => ['repl', 'import', 'simulate', 'stats'].includes(token));
  console.error(commandUsage(error.command ?? (commandHint as 'repl' | 'import' | 'simulate' | 'stats' | undefined) ?? 'help'));
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

  case 'repl': {
    await runRepl(args.history ?? defaultHistoryFile());
    break;
  }
}
