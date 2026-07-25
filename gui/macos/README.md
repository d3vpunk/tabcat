# tabcat overlay (macOS)

A third front end next to the zsh plugin and the REPL, for the case where no
terminal is open and one command needs to run: press ⌥Space, an overlay appears
with a prompt and ghost text from the same engine, and the app you were working in
stays frontmost.

This is a skeleton. What works: the global hotkey, the overlay, the directory chip
row, and the prompt with live predictions from the daemon.

Not built yet:

- **execution** — Enter shows what *would* run; there is no PTY
- **`learn`** — a run does not yet feed the model, so the ranking never improves
  from overlay usage
- **cards and the badge stack** — the shrink-into-the-corner animation exists only
  as a spike
- **filtering the chip row by typing** — ⌘-digit and the ⌥ cycle cover the fluent
  path, so this waits until the row is long enough to be worth it

## Keys

| | |
|---|---|
| ⌥Space | show the overlay; press again with ⌥ still held to walk the chip row |
| ⌥→ / ⌥← | walk the chip row while ⌥ is held |
| release ⌥ | commit the directory, caret is already in the field |
| ⌘1…⌘9 | jump straight to a chip |
| Tab or → | accept the ghost |
| Enter | submit (currently: show what would run) |
| Escape | clear the line |

The ⌥Space double meaning is deliberate and is why `Controller` tracks whether ⌥
has been held continuously since the overlay appeared: the hotkey *is* ⌥Space, so
tapping Space again without releasing ⌥ cannot mean "toggle" — it has to mean "next
directory", exactly like a window switcher. Release ⌥ and ⌥Space toggles again.

## Requirements

macOS 26 and Swift 6.3. The deployment target is not conservatism-adjustable: the
visual language is Liquid Glass (`glassEffect`), which does not exist earlier.

A `tabcat` on `$PATH` new enough to answer `daemon path` and the `cwds` op.

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

## Diagnosing

An `LSUIElement` app has nowhere to print, so a broken socket path or a protocol
mismatch would simply look like "the overlay does nothing". Hence:

```sh
swift run TabcatGUI --check
```

It resolves the socket path, pings, asks for `cwds` and one prediction, and reports
each step. `bad_op: unknown op: cwds` means the *running daemon* predates the op —
restart it with `tabcat daemon stop`.

It also reports the cold-start seed even when it would not be used, because that
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
