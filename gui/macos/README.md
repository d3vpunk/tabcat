# tabcat overlay (macOS)

A third front end next to the zsh plugin and the REPL, for the case where no
terminal is open and one command needs to run: press ⌥Space, an overlay appears
with a prompt and ghost text from the same engine, and the app you were working in
stays frontmost.

What works: the global hotkey, the overlay, the directory chip row, the prompt with
live predictions and a ranked candidate list, running commands in a pseudo terminal
whose result is fed back to the daemon with `learn` — so overlay usage improves the
same ranking the zsh plugin uses — and a rail of minimised runs in the bottom-right
corner.

The list is shown on an empty line as well, where it is the frecency ranking for the
current directory: what you usually do here, before you have typed anything. It also
carries what a ghost cannot. A ghost is drawn after the caret and can only append, so
a candidate that corrects the spelling (`doc` → `Documents/`) or a magic handle that
expands to something else entirely has no ghost — and used to be invisible as well as
unreachable. Accepting therefore applies the candidate, never the ghost.

The ghost is drawn in two weights: its first chunk, which `→` takes, a step brighter
than the rest, which `Tab` takes. It is the one place the difference between the two
keys can be seen instead of discovered by pressing them. The prompt is an `NSTextView`
the app owns rather than a `TextField`, so the ghost is placed by the same layout that
drew the text — as a separate view offset by a measured width it drifted off the edge
as soon as the line outgrew the field. Long lines wrap rather than scroll sideways,
and a line break (⌥Enter, or a paste that contains one) is simply another line.

Typing a magic handle and pressing Enter runs what it stands for, the way it does in
the REPL and the plugin. A handle is a whole line or it is not a handle: `lint --fix`
is a command that happens to start with one.

A line that only changes directory does not become a run. `cd frontend`, or just
`frontend`, moves the prompt instead — every run also reports the directory its shell
ended in, so `cd x && make`, `z api` and anything defined in an rc file move it too,
without having to be recognised.

Several commands can be in flight at once. Starting one sends the previous card to
the rail rather than replacing it; ⌘↓ sends the front card away by hand, a click
brings a badge back. A clean run clears itself from the rail after a few seconds; a
failed one stays, because an error nobody saw is the same as no error at all — but
Escape clears both, since by then the user is looking at them and saying away.
Anything still running is never removed on its own; only its own ✕ ends it.

A badge is 300 pt wide, so it shows its magic name where the command has one —
`⚡sshfriday` rather than the first forty characters of an `ssh` line, which is the
part every one of them has in common. Resolved when the command is submitted, from
the same `names` the REPL and the plugin write to, and either way: the line typed
*was* the handle, or the daemon happens to have a name for the line typed in full.
The card in front keeps showing the command, since there is room for it and the
terminal underneath is showing that command's output.

Not built yet:

- **typing into a running command.** The card shows a real terminal, so `vim` and a
  progress bar render correctly, but keystrokes are not routed to it yet — a `sudo`
  prompt still waits and is cancelled with Escape. Now that a real terminal is in
  place this is safe to add: input goes to the pty and the *child* controls echo
  through termios, so `sudo` hides a password exactly as it does in Terminal.app.
  The earlier objection applied to routing a SwiftUI text field into the pty, which
  would have shown it in plain text.
- **filtering the chip row by typing** — ⌘-digit and the ⌥ cycle cover the fluent
  path, so this waits until the row is long enough to be worth it.

Commands run through `$SHELL -ic`, so aliases, functions and PATH edits from your
rc file exist — most of what a person types is an alias. `TABCAT_PLUGIN_NO_SETUP=1`
is set for that shell, or every single run would load tabcat's own plugin, bind
keys and warm a daemon.

## Commands that are held back

`rm -rf`, `git reset --hard`, `git push --force`, a `>` onto a file that already
exists, and a dozen shapes like them are not run on Enter. They are shown with what
they will do and wait for ⌘Enter.

The overlay changed the stakes, which is why this exists. In a terminal a
destructive command sits in the scrollback next to everything else that happened,
and it took a deliberate visit to that window to type it. Here it is a hotkey,
three characters and Enter, with no history on screen afterwards to reconstruct what
happened.

⌘Enter and not Enter: a confirmation that the triggering key also satisfies is no
confirmation at all, because a habitual double-tap sails straight through it.

**It is a heuristic against accidents, not a security boundary, and it cannot
become one.** The command runs through `zsh -ic`, so an alias can expand to anything
after the scan has looked at it; a variable, a `bash -c` or a script hides its
contents entirely. The point is to catch the shapes people type by mistake. The
table in `--check` pins both directions, because a missed `rm -rf` costs work and a
false alarm on `npm test` trains you to confirm without reading.

## Keys

| | |
|---|---|
| ⌥Space | show the overlay; press again with ⌥ still held to walk the chip row |
| ⌥→ / ⌥← | walk the chip row while ⌥ is held |
| release ⌥ | commit the directory, caret is already in the field |
| Escape | one rung at a time: drop a held-back command, else clear the line, else send the card in front to the rail, else hide the overlay and every finished badge with it |
| click beside a card | the same as that last rung |
| ⌘1…⌘5 | jump straight to a chip |
| ↑ / ↓ | move through the candidate list |
| Tab | accept the selected candidate, or step to the next one when it is already complete |
| → | accept one chunk, at the end of the line and where a ghost is shown |
| ⇧Tab | undo the last accept |
| Enter | on a row reached with ↑/↓: fill the line. Otherwise: run it |
| ⌥Enter | a line break — a command may span lines, and no mode is involved |
| click a row | same as Enter on it — fill the line, do not run |
| ⌘Enter | confirm a command that was held back |
| ⌘↓ | send the front card to the rail |
| click a badge | bring it back to the front, launcher and all |
| hover a card | reveals its close button — ✕, or stop when it is still running |
| click a breadcrumb | go to that directory |

The overlay's own key is configurable, because which combination is free is a
property of a machine and not of this program — ⌥Space is what Alfred and Raycast
take by default, and a launcher whose trigger is already owned opens two windows.

```sh
defaults write nl.d3vpunk.tabcat.gui hotkey "ctrl cmd s"   # the bundled app
TABCAT_HOTKEY="ctrl cmd s" swift run TabcatGUI             # a development run
```

Both exist because neither reaches the other: an app started from the Finder inherits
no environment, and a bare `swift run` has a different defaults domain than the
bundle. `--check` prints whichever one is in force.

Words in any order, one non-modifier key: `cmd`, `ctrl`, `opt`/`alt`, `shift`, plus
`space`, `escape`, `return`, `tab`, a letter or a digit. Anything unparseable falls
back to ⌥Space rather than leaving no way in at all.

Whatever the combination is, its modifiers are the hold-to-cycle chord: the table
above says ⌥ because that is the default, but with `ctrl cmd s` it is ⌃⌘ that is held
and `s` that steps to the next directory. Two neighbours to avoid: **⌃⌘Space is the
Emoji picker** and ⌃Space switches input sources.

The ⌥Space double meaning is deliberate and is why `Controller` tracks whether ⌥
has been held continuously since the overlay appeared: the hotkey *is* ⌥Space, so
tapping Space again without releasing ⌥ cannot mean "toggle" — it has to mean "next
directory", exactly like a window switcher. Release ⌥ and ⌥Space toggles again.

## Requirements

macOS 26 and Swift 6.3. The deployment target is not conservatism-adjustable: the
visual language is Liquid Glass (`glassEffect`), which does not exist earlier.

A `tabcat` on `$PATH` new enough to answer `daemon path` and the `cwds` op.

The overlay starts a daemon itself when none is listening, the way the zsh plugin
does. That is not a nicety: the daemon exits after 45 minutes idle and this front
end only talks on a keystroke, so coming back to a dead socket is the normal case.
Recovering by asking you to open a terminal would defeat the one situation the
overlay exists for.

## Build and run

```sh
swift run TabcatGUI            # development: activation policy set in code
./bundle.sh                    # build/Tabcat.app, with LSUIElement from Info.plist
```

The bundle matters for more than tidiness: `LSUIElement` lives in `Info.plist`, and
without it the overlay gets a Dock icon and switches the active application when it
appears.

```sh
killall TabcatGUI 2>/dev/null; open build/Tabcat.app
```

The `killall` is not optional — `open` otherwise sometimes brings the already
running instance forward, and you debug code that is not running.

`bundle.sh` also copies the SwiftPM resource bundles into `Contents/Resources`.
Without that step `Bundle.module` finds nothing once the app is bundled, while the
same code works under `swift run` — the wordmark would go missing in one build and
not the other.

### The wordmark

`Sources/TabcatGUI/Resources` holds two files, both derived from `logo-text.png` in
this directory: cropped to the mark plus a little glow and scaled to 440 px wide.
`logo-text-on-dark.png` additionally has the near-black "tab" lightened, keyed on
saturation so the purple "cat" is untouched. Two files rather than one tinted
template, because the two-tone is the logo; and near-black on the dark glass is a
smudge, not a word.

## Diagnosing

An `LSUIElement` app has nowhere to print, so a broken socket path or a protocol
mismatch would simply look like "the overlay does nothing". Hence:

```sh
swift run TabcatGUI --check
```

It resolves the socket path and the wordmark's resource bundle, pings, asks for
`cwds` and one prediction, runs three pty probes (exit code, a progress bar redrawing
in place, the `pwd` wrapper), and finishes with the pinned tables below — reporting
each step. Run it from inside the app (`build/Tabcat.app/Contents/MacOS/TabcatGUI
--check`) to test what the bundled build sees rather than what `swift run` does. `bad_op: unknown op:
cwds` means the *running daemon* predates the op — restart it with `tabcat daemon
stop`.

```sh
swift run TabcatGUI --tables
```

Only the tables: exit-status decoding, the hazard scan, accepting, chunking,
navigation and the layout, all of them pure functions over pinned cases. No daemon,
no socket, no pty — which is why this and not `--check` is what CI gates on.

```sh
TABCAT_SOCKET=/tmp/scratch.sock swift run TabcatGUI --selftest
```

`--selftest` goes one step further: it runs a command in a pty, reports it with
`learn`, then asks for it back through `predict` and checks that its directory
turned up in `cwds`. That loop is what makes the overlay part of the same model
rather than a parallel universe, so it is worth being able to prove. It has its own
flag because it **appends a history entry** — point `$TABCAT_SOCKET` at a scratch
daemon, not at your own.

`--check` also reports the cold-start seed even when it would not be used, because that
path only runs on a fresh install — the one moment nobody is watching a diagnostic.
That is not paranoia: the first implementation used
`mdfind "kMDItemFSName == '.git'"` and returned nothing at all, because Spotlight
does not index hidden entries and therefore cannot see the one marker that
identifies a repository. It is a pruned `find` now.

## Signing

Irrelevant locally: Gatekeeper only checks what a browser marked with
`com.apple.quarantine`, and a self-compiled binary never carries it. `bundle.sh`
signs ad-hoc by default; set `TABCAT_SIGN_IDENTITY` to use a stable identity, which
only matters if something TCC-gated is ever added — then the permission survives a
rebuild instead of needing to be granted again. Notarisation is a question for the
day someone else downloads this.

## The boundary to the rest of the repo

The overlay talks to tabcat over **two** channels and no others: the daemon socket,
and `tabcat daemon path` to find it. It imports no TypeScript and reads no history
file directly. Keeping that line intact is what makes moving this into its own
repository a move rather than a rewrite.

One external dependency: **SwiftTerm**, pinned to a revision rather than a version
range, because it is roughly 15k lines of someone else's terminal emulator inside a
process that runs shell commands, and a tag can be moved.

Watch its exit reporting. `LocalProcess` has two termination paths that disagree
about what the `exitCode` parameter means — one hands over the raw `waitpid` status,
the other an already-decoded code — so `exit 3` can arrive as 768. `ExitStatus`
normalises it, and `--check` pins nine cases, because the daemon's `learn` accepts
anything up to 4096 and would have stored the raw number without complaint.

Three things are duplicated from the engine on purpose, each with a reason:

- `Wire.swift` mirrors the four escapes from `src/daemon/protocol.ts`. The zsh
  plugin mirrors them too; there is no way to share code across three languages.
- `ghostText(for:line:cursorCodePoints:)` mirrors `_tabcat_ghost_for_candidate`.
  A ghost is drawn *after* the caret, so it can only append — a candidate that
  corrects what was typed (`doc` → `Documents/`) must show no ghost at all, or the
  overlay would render something other than what accepting inserts.
- The cursor goes over the wire in **code points**, not UTF-16 units, because that
  is what the daemon expects. Sending Swift's `utf16.count` shifts every offset in
  a line containing an emoji.
