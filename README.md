<p align="center">
  <img src="tabcat-logo.png" alt="tabcat logo" width="240">
</p>

<h1 align="center">tabcat</h1>

<p align="center">
  <strong>Stop retyping the parts of commands that never change.</strong><br>
  Tab through the familiar parts. Type what's different. Keep moving.
</p>

<p align="center">
  <img alt="Node.js ≥ 20" src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="Shells: zsh and bash" src="https://img.shields.io/badge/shells-zsh%20%7C%20bash-blue">
</p>

tabcat is a **smart terminal prompt that learns from your shell history**. Instead of accepting a whole suggested command and editing it back, use Tab to fill in the recurring parts and type the bits that change.

## Less typing, more doing

You know the command. You've run some version of it dozens of times. Only the branch, path or argument is different today.

Suppose your history contains `git checkout develop` and `git checkout feature/login`:

```text
You type      git ch
Press Tab     git checkout
You finish    git checkout feature/new-dashboard
```

tabcat learns the shared `git checkout ` prefix and stops before the branch choice. For longer commands, keep alternating Tab and typing as you go.

- **Reuse the familiar parts.** Completion works in chunks, not just whole lines, and stops where your learned commands diverge.
- **Stay in context.** Recent and frequently used commands rank higher, with a boost for commands you've run in the current directory.
- **Keep it local.** Learning and prediction happen on your machine. No cloud model, account or telemetry.

## 🚀 Quick start

**Requirements:** Node.js >= 20, and zsh or bash.

```bash
npm install -g tabcat
tabcat import           # learn from your existing shell history
tabcat                  # open the smart prompt
```

Start typing a command you use often. Suggestions appear as ghost text and in a dropdown below your input. Importing your history gives tabcat something to work with immediately; it keeps learning as you use it.

Prefer to try it without a global install? Run `npx tabcat import`, then `npx tabcat`.

**No shell configuration changes needed.** Press `Ctrl+D` to leave tabcat and return to your regular shell.

> **A smart prompt, not a persistent shell session:** each command runs in an isolated shell. Directory changes persist, but exports, functions and aliases defined during the session do not carry over to the next command. Startup aliases are imported at launch. [More about shell sessions](docs/guide.md#shell-sessions).

## Make yourself at home

The REPL includes optional prompt plugins, controlled through `:settings`:

- `repl.plugins.git.enabled` (on by default): branch, local changes and Git operation state. Requires an installed `git`; never fetches from the network.
- `repl.plugins.clock.enabled` (off by default): local time, on the right of the same prompt line when space permits.

Git keeps the branch neutral and colors only its status: green `✓` for a clean
working tree, yellow `●` for changes, `↔ merge` / `↻ rebase` for an operation,
and red `! conflict` for conflicts. A detached HEAD shows `◇ detached` (or
`● detached` with changes). Conflicts take priority over operations and changes.
`↑N ↓N` shows ahead/behind against the locally known upstream; a green check
does not mean everything is pushed or tests have passed.

Changes apply on returning from settings. Plugins do not change the macOS UI or
the zsh prompt. Git refreshes for each new prompt without blocking input; results
that arrive after you start editing are omitted for that prompt to keep the input
position stable. Optional context gives way to the command on narrow terminals.

Four shortcuts cover the basics:

| Key | What it does |
|---|---|
| `Tab` | Accept the selected completion |
| `→` | Accept just one chunk |
| `Shift+Tab` | Undo the last accept |
| `Ctrl+R` | Search your history |

Use `↑` / `↓` to move through suggestions. Working in a small IDE terminal? Try `tabcat --minimal` for a compact prompt.

[Full key reference, paste behavior and optional autostart →](docs/guide.md)

## ⚡ Give long commands a short name

Some commands are worth remembering, but not worth typing:

```bash
docker compose -f qlico/compose.yaml run php vendor/bin/phpstan analyze src
```

Type the command, press **`Ctrl+N`**, name it `analyze`, and press **`Ctrl+S`** to save without running.

Next time, type `analyze` and press `Tab` to expand the full command. Inspect it, add arguments or run it as-is. An exact name followed by `Enter` also runs it directly.

Names belong to the current directory by default, so each project can have its own `analyze`. Switch to a global name with `Ctrl+G` when you want it available everywhere.

[More about magic names →](docs/guide.md#magic-names)

## Good to know

- **Your history stays on disk.** Commands and names are stored under `~/.config/tabcat/` by default. Treat those files as sensitive shell history. [Data and storage](docs/reference.md#local-data).
- **It learns your workflow over time.** Imported history supplies commands; directory-specific ranking develops as you run them in tabcat.
- **The project is young and evolving.** The REPL is the main interface and is being polished. Feedback and contributions are welcome.

## Other ways to use tabcat

**Already happy in zsh?** The [zsh plugin](docs/zsh-plugin.md) adds completion inside your existing shell session and shares the REPL's learned history and magic names.

**No terminal open?** The [macOS overlay](gui/macos/README.md) is a separate launcher powered by the same engine. It is currently in beta.

## 📚 Go deeper

| Document | What you'll find |
|---|---|
| [REPL guide](docs/guide.md) | Keys, magic names, pasting, shell sessions and autostart |
| [CLI and configuration](docs/reference.md) | Commands, settings, local data and daemon management |
| [zsh plugin](docs/zsh-plugin.md) | Setup, key bindings, configuration and history exclusions |
| [Development and architecture](docs/development.md) | Build from source, prediction algorithm, tuning and tests |
