# Development and architecture

[Back to the README](../README.md) · [CLI reference](reference.md)

## Build and run

```bash
git clone https://github.com/d3vpunk/tabcat.git tabcat
cd tabcat
npm install             # prepare script builds dist automatically
npm link                # put the CLI on your PATH
npm test
npx tsx src/cli.ts simulate --line 'git ch'
npx tsx src/cli.ts repl
```

Node.js >= 20 is required. zsh is required for plugin tests; those tests skip when it is unavailable.

## How prediction works

The engine is a pure, terminal-independent TypeScript library.

1. **Lexer:** split each command into typed chunks such as words, flags, separators, quotes, operators and spaces. Reconstruction is lossless: `join(lex(line)) === line`.
2. **Chunk model:** variable-length n-grams over chunk sequences, with `BEGIN`/`END` sentinels, record occurrences with timestamps and working directories.
3. **Frecency scoring:** combine long-term decay with a floor for old favorites and heavily weighted short-term decay. Boost occurrences learned in the current directory.
4. **Variability-aware merge:** look ahead from the top candidate and merge following chunks while the top continuation carries at least 90% of the probability mass. Stop at a genuine fork or where learned lines usually end.
5. **Prediction:** rank history candidates structurally. Longest matching context wins; shorter back-off contexts fill gaps. Enrich with live filesystem completion.

A fork directly after a fully typed word is not a dead end: `cd projects` + Tab offers branches such as `/radio` and `/tabby`, ranked by frecency. The ghost previews the top branch; `Shift+Tab` undoes acceptance. Where lines usually end, as with `git status`, ghost text stays quiet and branches remain in the dropdown.

Filesystem completion is case-insensitive and quote- and escape-aware (`doc` + Tab can yield `Documents`). It is suppressed directly after flag values so inputs such as `-m` are not flooded with paths. For `cd`, learned directories missing from the current location are demoted behind existing ones, not dropped.

Commands exiting with 126/127 are not learned. History storage is capped at 20,000 entries and compacted atomically.

## Algorithm tuning

Defaults in `DEFAULT_SCORING`, `DEFAULT_MERGE` and `DEFAULT_PREDICTOR`:

| Parameter | Default | Effect |
|---|---|---|
| `halfLifeDays` | 7 | Long-term frequency decay |
| `shortHalfLifeHours` | 4 | Short-term decay |
| `shortWeight` | 8 | Weight of short-term scoring |
| `cwdBoost` | 3 | Multiplier for commands learned in the current directory |
| `backoffPenalty` | 0.3 | Discount per shorter-context back-off level |
| `merge.threshold` | 0.9 | Probability mass required to keep merging |
| `topN` | 50 | Ranked candidate pool; the dropdown shows five with scrolling |
| `staleThreshold` | 0.25 | Below this score, a candidate ranks behind fresh back-off when no prefix is typed |

Use `tabcat simulate --line 'git ch'` to inspect ranking without the UI. Add `--cwd`, `--now` or `--json` for controlled experiments and bug reports.

## Daemon design

The zsh plugin and macOS overlay share a background engine host. The plugin keeps a persistent Unix socket connection, avoiding a process launch on each keystroke. The wire format is TSV because zsh has no built-in JSON parser.

Measurements on macOS with zsh 5.9 were 0.027 ms per request over a persistent descriptor, compared with roughly 6 ms for an `nc -U` fork and 110 ms for a Node cold start. A cold daemon needed about 0.3 s to listen. Starting it asynchronously at shell startup added about 14 ms rather than delaying the first keystroke.

`tabcat daemon path` lets clients that cannot import TypeScript resolve the socket without duplicating path rules, including Unix socket path-length constraints. It prints one line without starting the daemon: `--socket` wins, then `TABCAT_SOCKET`, then the computed default.

The `cwds` operation ranks working directories using the same frecency curve as prediction. This gives the desktop overlay a directory context. Only commands observed by tabcat contribute: imported shell history contains no working directories, so a fresh import produces an empty directory ranking.

For warm-up, idle shutdown, fallbacks and update behavior, see [daemon lifecycle](reference.md#daemon-lifecycle-and-updates).

## Project layout

```text
src/
  engine/              # terminal-independent prediction library
    lexer.ts           # lossless line-to-chunks conversion
    model.ts           # n-grams, frecency scoring and back-off
    merge.ts           # variability-aware acceptance
    predictor.ts       # (line, cursor, cwd) -> ranked candidates
    fs-completer.ts    # path completion with injectable filesystem
    shell.ts           # shell adapters, aliases, execution and import
    store.ts           # JSONL history, locking and compaction
    names.ts           # magic-name validation and index
    names-store.ts     # name persistence with tombstone deletion
  daemon/
    protocol.ts        # TSV wire format
    engine-host.ts     # predictor, names, tail-follow and compaction
    server.ts          # socket, warm-up, idle exit and connection caps
    client.ts          # one-shot management client
    paths.ts           # socket paths and ownership checks
  plugin/
    tabcat.plugin.zsh  # widgets, ghost text, hooks and key bindings
    init.ts            # setup snippet and preflight checks
  repl/
    app.tsx            # Ink prompt, dropdown and ghost text
    prompt-state.ts    # pure UI state machine
    executor.ts        # isolated shell execution with cwd persistence
    run.ts             # prompt -> execute -> learn loop
  settings/            # setting definitions and persistence
  cli.ts               # command dispatch
gui/
  macos/               # Swift overlay app, using the daemon
```

## Testing

The lexer, model, merge and predictor have terminal-independent scenario tests covering context back-off, directory boosts, time shifts and filesystem merging.

Plugin tests cover three levels: cross-language parity for the TSV protocol and socket paths; shell functions in a pristine `zsh -f` for privacy, buffer editing, key wiring and hook order; and real widgets driven through `zpty` pseudo terminals.

See the [macOS overlay README](../gui/macos/README.md) for its separate build, diagnostics and known gaps.
