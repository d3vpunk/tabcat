# zsh plugin

[Back to the README](../README.md) · [CLI and configuration](reference.md)

The REPL is the main way to use tabcat. If you prefer to stay inside your existing zsh session, the plugin adds ghost text, Tab acceptance and learning directly to your shell.

Both interfaces share `history.jsonl` and `names.jsonl`, so you can switch between them and each learns from the other. Bash is not supported as a plugin; use the REPL instead.

## Setup

```bash
tabcat plugin init zsh              # print the line for your .zshrc
tabcat plugin init zsh --check      # check node, zsh, modules and socket path
```

Add the printed line to `~/.zshrc`:

```sh
source /path/to/tabcat/dist/tabcat.plugin.zsh
```

The learning hook puts itself first regardless of the source line's position. Set any plugin configuration variables before the source line.

## Keys

The plugin uses the `Ctrl+X` family instead of taking over plain Ctrl shortcuts. In the notation below, `^Xl` means `Ctrl+X`, then `l`.

| Key | Action |
|---|---|
| `Tab` | Accept the top candidate; without candidates, use the previous Tab binding (compsys, fzf-tab) |
| `→` | Accept one chunk, only at the end of the line |
| `Shift+Tab` | Undo the last accept |
| `Enter` | Expand an exact magic-name handle, then run it |
| `^Xl` | Label: name the current command for this directory |
| `^XL` | Label the command for every directory |
| `^Xf` | Forget the current command's name |
| `^Xq` | Query: fuzzy history search |
| `^Xv` | View candidates using `compadd` and `menu-select` |

Ghost text is suppressed when a suggestion would correct typed text, such as `doc` to `Documents/`. Ghost text can only append after the cursor, so showing that remainder would misrepresent what Tab inserts. `Tab` and `^Xv` still offer the candidate.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `TABCAT_GHOST` | `1` | Ghost text on/off |
| `TABCAT_BADGE` | `1` | Handle badge on/off; appears when input leads to a named command, not just when complete |
| `TABCAT_GHOST_STYLE` | `fg=8` | Ghost text highlight |
| `TABCAT_KEY_LABEL` / `_LABEL_GLOBAL` / `_FORGET` / `_QUERY` / `_MENU` | `^Xl` / `^XL` / `^Xf` / `^Xq` / `^Xv` | Rebind the chords |
| `TABCAT_TIMEOUT` | `0.05` | Seconds to wait for the daemon before falling back |
| `TABCAT_NO_LEARN` | unset | Set to `1` to stop learning in this shell |
| `TABCAT_SOCKET` | derived | Socket path, matching `tabcat daemon --socket` |
| `TABCAT_WARM_ON_LOAD` | `1` | Start the daemon when the shell starts instead of on the first keystroke |
| `TABCAT_FORCE` | unset | Load despite detected conflicts and take over bound chords |

## History and privacy

The plugin learns commands except those excluded by these shell history rules:

- Commands with a leading space when `hist_ignore_space` is set.
- Commands matching `HISTORY_IGNORE`.
- `history` and `fc` when `hist_no_store` is set.
- All commands when `TABCAT_NO_LEARN=1`.

Learned lines are stored in `~/.config/tabcat/history.jsonl` (mode 0600), and handles in `names.jsonl` alongside it. Delete either file to forget its contents. See [local data](reference.md#local-data) for storage details.

## Background daemon

The plugin holds one Unix socket connection per shell and requests predictions on each keystroke. It starts the daemon at shell startup, without waiting for it to become ready. Later shells reuse the running daemon.

Missing, slow or incompatible daemons cause a fallback to plain zsh behavior rather than blocking the shell. See [daemon lifecycle and updates](reference.md#daemon-lifecycle-and-updates) for management commands and update behavior, or [development](development.md#daemon-design) for protocol and performance details.
