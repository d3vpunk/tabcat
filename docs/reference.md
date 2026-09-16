# CLI and configuration

[Back to the README](../README.md) · [REPL guide](guide.md) · [zsh plugin](zsh-plugin.md)

## Commands

| Command | Description |
|---|---|
| `tabcat` / `tabcat repl` | Start the smart prompt |
| `tabcat --minimal` | Compact REPL: one suggestion row, inline counter, no legend line |
| `tabcat import [--file <path>]` | Seed the model from zsh/bash history |
| `tabcat simulate --line 'git ch' [--cwd <dir>] [--now <ms>] [--json]` | Show ranking and what Tab would insert; JSON output is useful for scripts and bug reports |
| `tabcat stats` | Show history entry and directory counts |
| `tabcat names` | List magic names |
| `tabcat settings [list]` | List settings, defaults and overrides |
| `tabcat settings get <key>` | Print a setting's value |
| `tabcat settings set <key> <value>` | Change a setting |
| `tabcat settings reset <key>` | Restore a setting's default |
| `tabcat plugin init zsh [--check]` | Print the plugin source line or run preflight checks |
| `tabcat daemon` | Run the prediction daemon in the foreground |
| `tabcat daemon status` | Show the daemon's version, protocol, state and PID |
| `tabcat daemon stop` | Stop the daemon |
| `tabcat daemon path` | Print the socket path without starting or contacting the daemon |
| `tabcat --version` | Print the installed version |
| `tabcat help` | Show CLI help |

Options may appear before or after the command. Use `tabcat <command> --help` for command-specific help.

## Paths and settings

| Option | Purpose |
|---|---|
| `--history <path>` | Alternative history file; default: `~/.config/tabcat/history.jsonl` |
| `--socket <path>` | Alternative daemon socket; overrides `TABCAT_SOCKET` |

Without an explicit socket path, tabcat uses `TABCAT_SOCKET`, then `$XDG_RUNTIME_DIR/tabcat/daemon.sock`, with `/tmp/tabcat-<uid>/daemon.sock` as the fallback.

`tabcat settings list` shows the available settings and marks overrides with `*`. Settings that require a restart are marked in the output. The settings file lives alongside the history file.

For plugin-specific environment variables, see [plugin configuration](zsh-plugin.md#configuration). For engine scoring defaults, see [algorithm tuning](development.md#algorithm-tuning).

## Local data

Learning and prediction run locally, without network requests or telemetry. The commands you execute can still access the network as usual.

By default, learned command lines are stored in `~/.config/tabcat/history.jsonl`, and magic names in `names.jsonl` alongside it. Treat these files as sensitive shell history: command arguments may contain secrets. Delete the corresponding file to forget history or names.

History is append-only between compactions and capped at 20,000 entries. Beyond that, the file is compacted atomically to retain the most recent entries, limiting startup time and memory use.

Commands exiting with status 126 or 127 (not executable or not found) are not learned. The zsh plugin also respects [specific shell history exclusions](zsh-plugin.md#history-and-privacy); those rules describe the plugin, not the REPL.

## Daemon lifecycle and updates

The zsh plugin and macOS overlay use the prediction daemon; the REPL does not need it. The daemon keeps the model in memory, compacts history and exits after 45 minutes idle.

While building the model it answers `warming`, allowing the plugin to fall back rather than block. If it is missing, slow or uses an incompatible protocol, the plugin falls back to plain zsh behavior.

The daemon watches its own module file and shuts down within a minute after an update replaces it. The next shell start or keystroke starts a fresh instance. Use `tabcat daemon status` to check which version is listening.

A daemon from a version predating that self-check must be stopped manually or left to idle out:

```sh
tabcat daemon stop
```

An old daemon returns `bad_op` for unknown operations or `bad_protocol` for a protocol mismatch. The plugin then disables itself for the session and falls back to plain zsh.

History, names and settings files are carried forward unchanged; no migration is required on update.
