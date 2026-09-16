# REPL guide

[Back to the README](../README.md) · [CLI and configuration](reference.md)

Start the smart prompt with `tabcat`. It shows ghost text and a scrolling dropdown of suggestions learned from your commands, alongside live filesystem completions.

## Keys

| Key | Action |
|---|---|
| `Tab` | Accept the selected candidate (fully merged); cycles when nothing new can be inserted |
| `→` | Accept one chunk at a time |
| `Shift+Tab` | Undo the last accept |
| `↑` / `↓` | Empty line: browse history (substring-filtered once you type); otherwise: move in the dropdown |
| `Ctrl+R` | Fuzzy history search |
| `Ctrl+N` | Name this command (magic name) |
| `Ctrl+G` | In the naming badge: switch between this directory and everywhere |
| `Ctrl+S` | In the naming badge: save without running the command |
| `Ctrl+X` | Forget the shown magic name |
| `Ctrl+Backspace` | Delete one chunk; `Alt+Backspace` deletes fast |
| `Ctrl+A/E/U/W/K/L` | Familiar readline shortcuts |
| `Esc` | Close the dropdown |
| `Ctrl+D` | Exit |

Half-typed lines are stashed when you browse history and restored when you come back, like zsh.

For short terminals or IDE panes, use `tabcat --minimal`: one suggestion row with an inline counter and no legend line. Search, paste mode and naming work as usual.

## Pasting commands

Multiline pastes bypass completion. The block appears verbatim below the prompt: `Enter` runs it exactly as pasted, and `Esc` discards it. Backslash continuations, quoting and one-command-per-line stay intact.

Nothing auto-runs: a pasted trailing newline never submits. Single-line pastes keep the normal inline behavior.

## Shell sessions

Each command runs in an **isolated shell**. The working directory persists between commands, including changes made by `cd x && make`.

Exported variables, shell functions, options and aliases defined during the session apply only to that one command. Aliases from your shell's startup config are imported once at launch. The REPL is not a persistent zsh or bash session; use the [zsh plugin](zsh-plugin.md) if you need completion inside your existing shell.

## Magic names

Give a long command a short handle with `Ctrl+N`. No config file is needed.

### Create and use

1. Type a command and press `Ctrl+N`.
2. Enter a handle of 3-16 characters using `a-z` and `0-9`.
3. Press `Ctrl+S` to save without running, or `Enter` to save and run. `Esc` cancels without executing.

**Enter always runs the command:** if the handle is invalid or collides with another name, the command runs without saving the handle.

Type the handle as the first word to see its resolved command as the top suggestion. `Tab` expands it so you can inspect it or append arguments. Typing the exact handle and pressing `Enter` runs the resolved command directly. History records the full command, never the handle.

When you type or complete a command that already has a handle, a badge shows its name.

### Directory and global scope

By default, a handle belongs to the directory where you created it. This keeps commands with relative paths tied to the right place.

Press `Ctrl+G` in the naming badge to switch to a global handle, available everywhere. This is useful for commands without a directory dependency, such as `claude --model haiku`.

A local and global handle with the same name can coexist. The local handle wins in its directory; elsewhere, the global one applies. Name collisions are checked only in the selected scope.

To change scope later: type the handle, expand with `Tab`, press `Ctrl+N`, switch with `Ctrl+G`, then save with `Ctrl+S`.

### Edit, delete and list

- Press `Ctrl+N` on a named command to edit the prefilled handle. Clear it and press `Enter` to delete it and run the command.
- Press `Ctrl+X` on a selected named suggestion or its badge to forget the name without running anything.
- Use `:names` in the REPL or `tabcat names` on the CLI to list handles.
- Set `TABCAT_MAGIC_NAMES=0` to disable the feature.

## Importing history

Run `tabcat import` to seed suggestions from `~/.zsh_history` or `~/.bash_history`. The shell is detected through `$SHELL`. Use `tabcat import --file <path>` for a different source file.

Re-imports are idempotent. Imported shell history has no working-directory information; directory-specific ranking develops as you run commands in tabcat.

## Optional autostart

To start tabcat in every new interactive terminal, add this to the end of `~/.zshrc` or `~/.bashrc`:

```sh
if [[ $- == *i* ]] && [[ -z "$TABCAT_AUTOSTART" ]] && command -v tabcat >/dev/null; then
  export TABCAT_AUTOSTART=1
  command tabcat repl
fi
```

The guard prevents nested shells and commands run by tabcat from re-entering the REPL. `Ctrl+D` or `:exit` returns to your regular shell.

With a lazy-loaded version manager such as nvm, ensure the Node bin directory is on `PATH` before this block runs. For example, `export PATH="$NVM_DIR/versions/node/<your-version>/bin:$PATH"`. Otherwise `command -v tabcat` may find nothing at startup.
