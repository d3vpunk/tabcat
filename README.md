<p align="center">
  <img src="tabcat-logo.png" alt="tabcat logo" width="240">
</p>

<h1 align="center">tabcat</h1>

<p align="center">
  <strong>Chunk-based shell autocomplete that learns from <em>your</em> commands.</strong><br>
  Tab, tab, tab through the stable parts of a command — type only the part that changes.
</p>

<p align="center">
  <img alt="Node.js ≥ 20" src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
  <img alt="Tests" src="https://img.shields.io/badge/tests-178%20passing-brightgreen">
  <img alt="Shells" src="https://img.shields.io/badge/shells-zsh%20%7C%20bash-blue">
</p>

---

## Why tabcat?

Most shell completion tools are **opportunistic**: they guess at whole commands from a giant, anonymous history and throw suggestions at you that you accept maybe once in a while. Autosuggestion plugins replay your *entire last matching line*; static completion specs only know flags, not *your* workflow.

tabcat is different by design: it helps you with the commands **you already run, over and over**. It breaks every command you execute into small chunks, learns which chunks are stable and which vary, and then lets you Tab through the stable scaffolding of a command — stopping exactly at the points where *you* usually make a decision.

- **Chunk-based, not line-based.** `git checkout feature/` and `git checkout bugfix/` share a stable prefix. tabcat completes `git checkout ` as one unit and *stops* — because that's where your commands diverge. Type the variable part yourself, then Tab again.
- **It learns from every use.** A frecency model (frequency × recency) with a strong short-term memory means what you worked on *this morning* outranks what you ran three weeks ago. It even knows *where*: commands learned in the current directory get a boost.
- **It never overshoots.** A variability-aware merge looks ahead along the prediction and stops Tab at the first real fork — you never accept five chunks of wrong suggestion you have to delete.
- **It's yours alone.** Everything is learned locally from your own history, stored in a local append-only file. No network, no telemetry leaves your machine, no model trained on other people's commands.

```text
$ git ch█                     ← you type two chunks
  git checkout develop        ← tabcat offers ranked candidates
$ git checkout ▊              ← Tab accepts the stable part, stops at the fork
$ git checkout feature/42-fix▊ ← you type the variable part — Tab again
```

## How it works

tabcat's engine is a pure, terminal-independent TypeScript library:

1. **Lexer** — every command line is split into small typed chunks (words, flags, separators, quotes, operators, spaces). Reconstruction is lossless: `join(lex(line)) === line`.
2. **Chunk model** — variable-length n-grams over chunk sequences (with `BEGIN`/`END` sentinels) record every occurrence with timestamp and working directory.
3. **Frecency scoring** — each occurrence scores as long-term decay (7-day half-life, with a floor so old favorites stay findable) plus a heavily weighted short-term decay (4-hour half-life: "today I'm working on X"), multiplied by a boost for commands learned in the current directory.
4. **Variability-aware merge** — when you hit Tab, tabcat looks ahead from the top candidate and merges following chunks only while the branching factor is ≈ 1 (the top continuation carries ≥ 90 % of the probability mass). At the first genuine fork — or where your lines usually end — the merge stops. That's the anti-overshoot rule.
5. **Prediction** — history candidates are ranked structurally (longest matching context wins; shorter back-off contexts only fill gaps), then enriched with live filesystem completion: case-insensitive, quote- and escape-aware (`doc` + Tab → `Documents`), and deliberately suppressed right after flag values so `-m` doesn't flood you with paths.

Typos don't poison the model: commands that exited with 126/127 (command not found / not executable) are never learned.

## The REPL

tabcat ships an Ink-based smart prompt with ghost text and a scrolling dropdown:

| Key | Action |
|---|---|
| `Tab` | Accept the selected candidate (fully merged); cycles when nothing new to insert |
| `→` | Accept one chunk at a time |
| `Shift+Tab` | Undo the last accept |
| `↑` / `↓` | Empty line: history (substring-filtered once you typed); otherwise: move in the dropdown |
| `Ctrl+R` | Fuzzy history search |
| `Ctrl+Backspace` | Delete one chunk · `Alt+Backspace` deletes fast |
| `Ctrl+A/E/U/W/K/L` | Familiar readline shortcuts |
| `Esc` | Close the dropdown |
| `Ctrl+D` | Exit |

Half-typed lines are stashed when you browse history and restored when you come back — like zsh.

Each command runs in an **isolated shell**. The working directory persists between commands (including `cd x && make`); exported variables, shell functions, options and aliases defined *during* the session apply only to that one command. Aliases from your shell's startup config are imported once at launch.

## Getting started

**Requirements:** Node.js ≥ 20, and zsh or bash.

```bash
git clone <repo-url> tabcat
cd tabcat
npm install
npm run build
npm link        # puts the CLI on your PATH

tabcat import   # seed the model from your zsh/bash history
tabcat          # start the smart prompt
```

Run `tabcat import` once — tabcat parses your existing `~/.zsh_history` or `~/.bash_history` (shell auto-detected via `$SHELL`) and starts with useful suggestions from day one. Re-imports are idempotent.

## CLI

| Command | Description |
|---|---|
| `tabcat` / `tabcat repl` | Start the smart prompt |
| `tabcat import [--file <path>]` | Seed the model from shell history |
| `tabcat simulate --line 'git ch' [--cwd <dir>] [--now <ms>]` | Show the ranking and what Tab would insert — explore and calibrate the algorithm without the UI |
| `tabcat stats` | History overview (entries, directories) |
| `tabcat --history <path>` | Use an alternative history file (default: `~/.config/tabcat/history.jsonl`) |

## Tuning the algorithm

The defaults in `DEFAULT_SCORING` / `DEFAULT_MERGE` / `DEFAULT_PREDICTOR`:

| Parameter | Default | Effect |
|---|---|---|
| `halfLifeDays` | 7 | Long-term decay of frequency |
| `shortHalfLifeHours` | 4 | Short-term decay ("today I'm working on X") |
| `shortWeight` | 8 | Weight of the short-term term |
| `cwdBoost` | 3 | Multiplier for commands learned in the current directory |
| `backoffPenalty` | 0.3 | Score discount per back-off level (shorter context) |
| `merge.threshold` | 0.9 | Probability mass the top next chunk must carry to keep merging |
| `topN` | 50 | Ranked candidate pool (the dropdown shows 5, scrolling) |
| `staleThreshold` | 0.25 | Below this a candidate counts as stale and ranks behind fresh back-off when no prefix is typed |

The learned history is capped at 20,000 entries; beyond that the append-only file is compacted atomically to the most recent entries (startup-time and memory protection).

## Project layout

```text
src/
  engine/            # pure TypeScript library — no terminal dependencies
    lexer.ts         # line → chunks (lossless)
    model.ts         # n-gram chunk model, frecency scoring, back-off
    merge.ts         # variability-aware merge (Tab stops at forks)
    predictor.ts     # facade: (line, cursor, cwd) → ranked candidates
    fs-completer.ts  # path completion (injectable FS)
    shell.ts         # zsh/bash adapters: alias snapshot, exec, history import
    store.ts         # append-only JSONL history, locking, compaction
  repl/              # Ink UI
    app.tsx          # rendering: prompt, dropdown, ghost text
    prompt-state.ts  # all UX logic as a pure, testable state machine
    executor.ts      # isolated shell execution with cwd persistence
    run.ts           # loop: prompt → execute → learn → prompt
  cli.ts             # repl / import / simulate / stats
```

## Development

```bash
npm install
npm test                                   # 178 scenario and unit tests
npx tsx src/cli.ts simulate --line 'git ch'
npx tsx src/cli.ts repl
```

The engine is fully decoupled from the terminal — the lexer, model, merge and prediction are tested against scenario suites (context back-off, cwd boost, time shift, filesystem merge) without any TTY.

## Status

tabcat is young and evolving. The engine is feature-complete; the REPL is built and being polished. Feedback and contributions welcome.
