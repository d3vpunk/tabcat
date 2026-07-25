# Plan: tabcat headless + zsh-Plugin (Variante 2 neben REPL)

> **Status: umgesetzt** auf Branch `feat/daemon-zsh-plugin`. Abweichungen vom
> Plan und was die Umsetzung zusätzlich gebracht hat, stehen unten in
> [Umsetzungsprotokoll](#umsetzungsprotokoll).

## Ziel

tabcat wird in zwei Varianten nutzbar:
1. **REPL** (existierend, unverändert) — eigener Smart-Prompt
2. **zsh-Plugin** (neu) — tabcat-Features direkt in der echten Shell des Users

Beide teilen Engine, `history.jsonl` und `names.jsonl`. Kein Datenverlust beim
Wechsel, gegenseitiger Lern-Profit.

## Architektur

```text
┌─ zsh ─────────────────┐        ┌─ tabcat daemon (node) ───────────┐
│ tabcat.plugin.zsh     │  TSV   │ Unix-Socket $XDG_RUNTIME_DIR/    │
│  zsocket, persist. fd │◄──────►│   tabcat/daemon.sock (0600)      │
│  zle widgets          │        │  Predictor (existierend)         │
│  precmd/preexec hook  │        │  Tail-Follow via Byte-Offset     │
└───────────────────────┘        │  Compaction + Idle-Exit          │
┌─ REPL (unverändert) ──┐        │                                  │
│ gleiche Engine        │───────►│  (Store + Locking existieren)    │
└───────────────────────┘        └──────────────────────────────────┘
```

### Messwerte (Basis aller Entscheidungen unten)

Gemessen auf macOS 25.4, zsh 5.9, node 20.19:

| Größe | Wert |
|---|---|
| `zsocket` persistenter fd, Roundtrip | **0,027 ms** (200 Requests) |
| `nc -U` Fork pro Request | **6 ms** |
| node cold start (`node -e ''`) | **106 ms** wall |
| `new Predictor()`, 2430 echte Entries | **129 ms**, RSS 166 MB |
| `new Predictor()`, 20k synthetische Entries | 313 ms, RSS 108 MB |
| `predictor.predict()` | **0,09 ms** |

Folgerungen: Daemon zwingend (cold start allein sprengt jedes Tastenbudget).
Persistenter fd zwingend (Fork pro Keystroke = 6 ms, plus kein State).
`predict` selbst ist gratis — die Kosten liegen in Build und Reload, deshalb
Tail-Follow statt Full-Reload (s. u.). RSS ist der Grund für Idle-Exit.
Kardinalität dominiert Speicher, nicht Entry-Anzahl — vor Release mit 20k
*echten* Entries nachmessen.

**Warum TSV im Hot-Path, nicht NDJSON:** zsh hat keinen JSON-Parser und keinen
base64-Builtin. JSON würde Encoder *und* Decoder in zsh bedeuten. TSV
escapes sich mit reiner Parameter-Expansion. NDJSON bleibt für
`tabcat simulate --json` und Debug (`socat`).

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Architektur | Daemon + Unix-Socket, Auto-start durch Plugin (Pidfile, flock, Retry) |
| Transport | `zmodload zsh/net/socket` + `zsocket`, ein persistenter fd pro Shell |
| Wire-Format | TSV (Plugin ↔ Daemon), NDJSON nur für CLI/Debug |
| Tab ohne Kandidaten | Fallback auf das beim Load gesnapshottete Original-Tab-Widget |
| Learning | Alle Shell-Commands via preexec/precmd — **außer** von `hist_ignore_space` / `HISTORY_IGNORE` / `TABCAT_NO_LEARN` ausgeschlossene (s. Privacy) |
| Feature-Scope v1 | Alles was als Plugin machbar ist (s. Widget-Tabelle) |
| Shells | zsh only. bash/fish später oder nie — REPL bleibt Antwort für bash |
| Keybinds | `^X`-Familie: `^Xl` Label, `^Xf` Forget, `^Xq` Query. Kein zsh-Default wird überschrieben (s. Keybind-Analyse) |
| Konflikte (autosuggestions, atuin, fzf) | Erkennen + warnen, `TABCAT_FORCE=1` überstimmt. Betrifft nur POSTDISPLAY- und Tab-Binder — die `^X`-Chords kollidieren mit keinem verbreiteten Plugin |
| Distribution | `tabcat plugin init zsh` printet Source-Snippet für .zshrc (starship-Pattern) |
| Tests | Protokoll-Transcript-Tests (vitest, primär) + kleiner zpty-Smoke-Set |

## Komponenten

### 1. Daemon (`src/daemon/`)

**Kommandos:** `tabcat daemon` (Vordergrund; Plugin spawnt detached),
`tabcat daemon status`, `tabcat daemon stop` — Debug und Bugreports.

**Socket-Pfad:** `$XDG_RUNTIME_DIR/tabcat/daemon.sock`, Fallback
`/tmp/tabcat-$UID/daemon.sock`. **Nicht** `~/.config`: `sun_path` ist auf
darwin 104 Bytes (lange Homes/Usernames reißen das), und NFS-Homes können
keine Sockets. Pidfile bleibt in `~/.config/tabcat/`.

**Lifecycle:**
- Auto-start: Widget findet Socket nicht → `flock` auf Pidfile → spawn
  detached → kurzer Retry. Doppelter Spawn durch flock ausgeschlossen
- Warm-up: solange der Predictor baut (0,25–1 s), antwortet der Daemon
  `state=warming`. Das Widget fällt dann auf compsys zurück — **niemals
  blockieren**
- Crash: nächster Request restartet einmal, dann stille Deaktivierung des
  Widgets für diese Shell. Die Shell des Users darf nie hängen
- Idle-Exit nach 45 min ohne Request. Grund: 166 MB RSS bei 2430 Entries;
  ein dauerhaft laufender Prozess pro User ist ohne Exit nicht vertretbar
- Connection-Cap (32) und Per-Connection-Buffer-Limit (64 KB pro Zeile).
  Ein hängender Client darf keinen Daemon-Speicher fressen

**Datenaktualität — Tail-Follow, kein Full-Reload:**
- Byte-Offset auf `history.jsonl` merken. Pro Request: `stat` → bei
  gewachsener Größe nur den Tail lesen und `predictor.learn()` pro neuem
  Entry. Kosten O(neue Zeilen)
- Full Rebuild nur bei geschrumpfter Datei (= fremde Compaction) oder
  Änderung an `names.jsonl`
- Naiver mtime-Reload wäre O(alle Entries) = 129 ms+ jedes Mal, wenn eine
  *andere* Shell ein Kommando lernt. Bei mehreren offenen Terminals also
  permanent
- Nebeneffekt: der eigene `learn`-Append triggert keinen Selbst-Reload mehr
  (bei mtime-Vergleich täte er das)

**Compaction:** Der Daemon compactet (`compactHistory`) beim Start und danach
alle 6 h. Bisher passiert das nur beim REPL-Start (`run.ts`) — ein
Plugin-only-User würde `MAX_HISTORY_ENTRIES` sonst unbegrenzt überschreiten.
Nach eigener Compaction den Byte-Offset neu setzen.

**Wire-Protokoll (TSV, eine Zeile rein, Antwort bis Leerzeile):**

```text
→ predict\t<id>\t<protocol>\t<limit>\t<cursor>\t<cwd>\t<line>
← ok\t<id>\t<prefix>\t<handle>
← <insert>\t<display>\t<source>\t<magicName>\t<replacePrefixLength>
← (Leerzeile = Ende)

→ learn\t<id>\t<protocol>\t<exitCode>\t<ts>\t<cwd>\t<line>
→ names\t<id>\t<protocol>\t<list|create|delete|resolve>\t<cwd>\t<name>\t<line>
→ search\t<id>\t<protocol>\t<limit>\t<cwd>\t<query>
→ ping\t<id>\t<protocol>
← ok\t<id>\t<version>\t<protocol>\t<state>\t<pid>
→ shutdown\t<id>\t<protocol>
← err\t<id>\t<code>\t<message>
```

Escaping: `\`, `\t`, `\n`, `\r` in jedem Feld (in zsh vier
Parameter-Expansionen; Decode einpassig via `${(g::)field}`). Feldanzahl fix
pro Op, das freitextige Feld ist immer das letzte.

`limit` begrenzt die Kandidatenzahl (Ghost: 1, Menü: 10) — 50 Zeilen pro
Keystroke zu lesen wäre Verschwendung. `handle` im Header ist der Handle der
exakt getippten Zeile: das Badge kostet damit keinen zweiten Roundtrip.

- **`id` pro Request ist Pflicht.** `read -t` timeoutet, die Antwort kommt
  später trotzdem an und desyncht den fd — sonst zeigt das nächste Ghost die
  vorherige Antwort. Client verwirft Mismatches; bei Timeout fd schließen und
  neu öffnen
- **`predict`** liefert dieselbe Semantik wie `simulate`: `prefix` +
  Kandidaten in Ranking-Reihenfolge, `[0]` preselected. Felder aus
  `RankedCandidate` (`insert`, `display`, `source`, `magicName`)
- **`learn`** appendet **roh** (auch exit 126/127) und ruft
  `predictor.learn()` — genau wie der REPL: `run.ts:229–234` schreibt alles,
  gefiltert wird erst in `Predictor.learn` (`predictor.ts:261`). Anders
  herum divergieren die beiden Stores
- **`completion`-Feld** von `HistoryEntry`: aus zsh gibt es kein Äquivalent →
  Feld wird weggelassen (es ist optional, nicht nullable — genau wie bei einem
  importierten Entry)
- **Versionsskew:** `ping` vergleicht `protocol` *und* `version`. Ein
  `npm i -g tabcat@neu` lässt sonst den alten Daemon mit alter
  Ranking-Semantik weiterlaufen. Mismatch → `shutdown` + respawn. Bei
  `protocol`-Mismatch, den der Client nicht sprechen kann: einmalige Warnung,
  Widget deaktiviert sich

**Socket-Permissions:** `chmod 0600` explizit nach `listen()` (umask kann
laxer sein), Verzeichnis 0700 — konsistent mit `store.ts`. `SO_PEERCRED`
existiert auf macOS nicht; 0600 im 0700-Verzeichnis ist die Verteidigung.

### 2. Headless-CLI

`tabcat simulate --json` — kein neues Kommando. Ein separates
`tabcat suggest` wäre eine fast identische Zweitvariante und würde die
Command-Union in `cli-args.ts` unnötig aufblähen. Für Scripting, CI-Tests und
Bugreports reicht `simulate` mit maschinenlesbarem Output (ohne Daemon).

### 3. zsh-Plugin (`dist/tabcat.plugin.zsh`)

**Init (`tabcat plugin init zsh`):**
- Printet `source …/tabcat.plugin.zsh`-Snippet für .zshrc
- `--check`: Konflikt-Report ohne Snippet
- Plugin-Init prüft: `[[ -o interactive ]]` (sonst sofort no-op — sonst
  betrifft das Plugin jedes `zsh -i`-Script), node ≥20, tabcat im PATH,
  `zmodload zsh/net/socket` verfügbar, bekannte Konflikte (POSTDISPLAY-Nutzer
  wie zsh-autosuggestions, fremde Tab-Binder wie fzf-tab) → Warnung mit
  Anleitung, `TABCAT_FORCE=1` überschreibt. Die `^X`-Chords brauchen keinen
  Konflikt-Check gegen Fremdplugins, wohl aber den gleichen
  „schon belegt?“-Test wie Tab

**Keybind-Analyse (gemessen in oh-my-zsh + `plugins=(git)`, emacs-Keymap):**

**Kein einzelner Ctrl-Key ist frei** — alle 21 (`^A`–`^Y`, `^_`) sind
zsh-Defaults. Auch `^N` (`down-line-or-history`) und `^R`
(`history-incremental-search-backward`) sind belegt; die ursprüngliche
Annahme „Ctrl+N frei, Ctrl+R prüfen“ war falsch. Frei sind nur Chords:

| Namespace | Frei | Belegt |
|---|---|---|
| `^X…` | `b f i j k l o p q v w x y z` | `a c d e g h m n r s t u ~ * = ?` + `^X^{B,E,F,J,K,N,O,R,U,V,X}` |
| `^[…` (Meta) | `e i j k o r v` | Rest — und macOS Terminal/iTerm braucht erst „Option as Meta“, also kein Out-of-the-box-Default |
| `menuselect` | fast alles | eigene Keymap, nur bei offenem Dropdown aktiv |

Gewählt: **`^X`-Familie.** Funktioniert ohne Terminal-Konfiguration, tastet
kein zsh-Default an, ist als Familie merkbar. Preis: zwei Anschläge.

**Widgets:**

| Widget | Taste | Verhalten |
|---|---|---|
| `tabcat-tab` | Tab | Merged accept des Top-Kandidaten. Keine Kandidaten / `state=warming` → beim Load gesnapshottetes Original-Widget aufrufen |
| `tabcat-forward-chunk` | → | Ein Chunk accept; nur bei Cursor am Zeilenende, sonst normales Cursor-Verhalten |
| `tabcat-shift-tab` | Shift+Tab | Letzten Accept rückgängig (State in Shell-Var) |
| `tabcat-accept-line` | Enter | **Wrapper um `accept-line`**: erstes Wort = Handle → BUFFER umschreiben, dann `zle .accept-line` |
| `tabcat-label` | **`^Xl`** | Label — Naming-Flow: `vared`-Miniprompt für Handle (3–16, a-z0-9), speichern via `names`-Op |
| `tabcat-forget` | **`^Xf`** | Forget — Magic name vergessen (Tombstone) |
| `tabcat-query` | **`^Xq`** | Query — Fuzzy-History als ZLE-`recursive-edit`-Loop |

Alle Bindings über Variablen überschreibbar (`TABCAT_KEY_LABEL`,
`TABCAT_KEY_FORGET`, `TABCAT_KEY_QUERY`), Auswertung vor dem `bindkey` —
plus Doku-Snippet für User, die lieber `^R`/`^N` opfern.

- **Enter/Expand ist ein Widget, kein preexec-Hook.** preexec läuft
  *nachdem* die Kommandozeile fixiert ist und kann sie nicht mehr ändern —
  Magic-Name-Expansion ist dort technisch unmöglich
- **Kein bares `Ctrl+X`.** `^X` ist Prefix-Keymap (`^X^E` edit-command-line,
  `^Xa` expand-alias, …). Bares `^X` zerstört den ganzen Prefix — deshalb
  ausschließlich Chords darunter
- **Shift+Tab:** beide Sequenzen binden — `${terminfo[kcbt]}` *und* `'^[[Z'`;
  nicht jedes Terminal schickt beide
- **Tab-Fallback:** Original-Binding beim Load snapshotten
  (`bindkey '^I'` parsen) und via `zle $orig` aufrufen. Ohne das verlieren
  fzf-tab-/compsys-User ihren Tab. Wir bauen keine Completion nach

**Ghost-Text — der größte Einzelbrocken:**
- Ghost muss bei *jedem* Keystroke aktualisieren. POSTDISPLAY allein tut das
  nicht: es braucht Widget-Wrapping über alle relevanten Widgets
  (`self-insert`, `backward-delete-char`, `kill-word`, History-Widgets …) —
  zsh-autosuggestions wrappt rund 30. Das ist eigener Aufwand, kein
  Nebenprodukt von Schritt 3
- Wrapper-Listen als überschreibbare Arrays (`TABCAT_FETCH_WIDGETS`,
  `TABCAT_CLEAR_WIDGETS`) nach autosuggestions-Vorbild — User mit exotischen
  Widgets können nachrüsten
- Fetch synchron über den persistenten fd (0,027 ms) — kein zsh-async in v1
- **Badge und Ghost teilen `POSTDISPLAY`.** Ein einziger Schreiber, der
  beides zu einem String komponiert (`<ghost> ⚡`), nicht zwei
- Dropdown via `compadd` + `complist` menu-select (idiomatisch, kein
  Custom-Render)

**Learning-Hook:**
- `preexec`: `$1` (line) **und `$PWD`** zwischenspeichern. cwd muss hier
  gegriffen werden, nicht in precmd — bei `cd x && y` wäre es dort schon
  falsch. Semantik wie REPL: gelernt wird, *wo getippt wurde*
  (`run.ts:217`)
- `precmd`: `$?` in der **ersten Zeile** lesen, dann `learn` senden,
  Stash leeren (sonst lernt ein leeres Enter die Zeile erneut)
- **Hook-Reihenfolge ist kritisch:** `precmd_functions` läuft sequentiell,
  starship & Co. zerstören `$?`. Deshalb nach dem Load voranstellen:
  `precmd_functions=(tabcat_precmd $precmd_functions)`. Damit ist die
  Source-Position in `.zshrc` egal — das gehört in die README
- Senden ist fire-and-forget, 50 ms Timeout, Fehler still

### 4. Privacy / Security

Ein Plugin, das „alle Shell-Commands“ lernt, schreibt sonst genau das in
`history.jsonl`, was der User bewusst aus der Shell-History herausgehalten
hat. Pflicht vor jedem Dogfooding, nicht danach:

- **`setopt hist_ignore_space` respektieren.** Kommandos mit führendem
  Leerzeichen sind die Standard-Methode, Secrets aus der History zu halten
  (`  export TOKEN=…`) — die dürfen nicht gelernt werden
- **`HISTORY_IGNORE`-Pattern respektieren** (zsh-Pattern-Match gegen die Zeile)
- **`hist_ignore_dups` / `hist_no_store`** analog behandeln
- **`TABCAT_NO_LEARN=1`** als globaler Opt-out, pro Shell setzbar
- Socket 0600, Verzeichnis 0700 (s. Daemon)
- README-Abschnitt „Was tabcat speichert und was nicht“ mit Pfaden und
  Löschanleitung

### 5. Tests

- **Primär: Protokoll-Transcript-Tests** (vitest) direkt gegen den Daemon,
  Socket in tmpdir: alle Ops, `id`-Mismatch-Verwerfen, Tail-Follow nach
  Append, Full-Rebuild nach Shrink, Warm-up-State, Crash-Restart,
  `protocol`- und `version`-Mismatch, Compaction + Offset-Reset,
  Connection-Cap, Buffer-Limit
- **Privacy-Tests:** `hist_ignore_space`, `HISTORY_IGNORE`, `TABCAT_NO_LEARN`
  führen zu keinem Append
- **zpty nur als Smoke-Set** (Tab-Accept, Ghost erscheint, Fallback bei
  leerem Ergebnis, Enter-Expand). zpty-Tests sind timing-flaky; die
  Abdeckung liegt im Transcript-Layer
- **CI:** `ci.yml` braucht einen eigenen zsh-Job — `ubuntu-latest` hat zsh
  nicht garantiert (`apt-get install -y zsh`), der macOS-Job macht derzeit
  nur Packaging
- **Parität:** gleiche history → REPL und Plugin liefern gleiche
  Top-Kandidaten (Szenario-Suite wiederverwenden)

## Detail-Defaults

1. Ghost-Fetch synchron, kein zsh-async-Pattern v1 (0,027 ms gemessen;
   Profiling kann das später ändern)
2. Plugin lernt auch `cd`-Commands (cwd-Kontext)
3. Kein `plugins=(tabcat)`-Integration für oh-my-zsh/antigen/zinit in v1. Das
   Source-Snippet funktioniert innerhalb einer omz-`.zshrc` (dort läuft die
   Dogfooding-Umgebung), sofern es **nach** `source $ZSH/oh-my-zsh.sh` steht —
   das precmd-Prepend macht die Position ansonsten unkritisch. Framework-Pakete
   später

## Umsetzungs-Reihenfolge

**Schritt 0 — Design-Entscheidungen festnageln (vor Code):**
Tail-Follow-Offset-Modell, Compaction-Ownership, Wire-Format TSV. Alle drei
ändern das Daemon-Design, nicht nur die Implementierung.

1. **Daemon**: TSV-Protokoll, Tail-Follow, Warm-up, Compaction, Idle-Exit,
   `daemon status|stop` + Transcript-Tests
2. **`simulate --json`** (klein, nützlich für alles Folgende)
3. **Privacy-Filter** (`hist_ignore_space`, `HISTORY_IGNORE`,
   `TABCAT_NO_LEARN`) — muss stehen, bevor irgendwer dogfoodet
4. **Plugin-Skelett**: init + Guards, `zsocket`-Client mit Reconnect/Timeout,
   Tab + Original-Widget-Fallback, Learn-Hook mit precmd-Prepend
5. **Ghost-Text**: Widget-Wrapping (eigener, großer Schritt) → **jetzt
   dogfoodbar**
6. Dropdown (compadd/menu-select), Chunk-Accept, `accept-line`-Wrapper für
   Magic-Names + Badge (ein POSTDISPLAY-Schreiber)
7. `^Xl` Label-Flow, `^Xf` Forget, Shift+Tab Undo
8. `^Xq` Fuzzy-Loop
9. zpty-Smoke-Set, zsh-CI-Job, Konflikt-Detect, README/CLI-Doku

## Risiken

- **Widget-Wrapping für Ghost-Text** (Schritt 5): unterschätzter Brocken,
  ~30 Widgets, jede fremde Plugin-Kombination ist ein potenzieller
  Interaktionsbug. Mitigation: überschreibbare Widget-Listen, Konflikt-Detect,
  `TABCAT_GHOST=0` als Notausgang
- **compadd-Fallback vs User-compsys-Config** (Schritt 6): Mitigation —
  Tasten ans gesnapshottete Original-Widget durchreichen, keine eigene
  Completion
- **`^Xq` ZLE-Loop** (Schritt 8): aufwändigstes Einzelfeature, bewusst
  zuletzt. Kann kippen ohne den Rest zu gefährden — `^R` bleibt ohnehin
  zsh/atuin, „keine Fuzzy-History“ ist ein akzeptables v1
- **Zwei-Anschlag-Chords als Preis der Koexistenz**: `^Xl`/`^Xf`/`^Xq` sind
  unbequemer als `^N`/`^R`. Mitigation: `TABCAT_KEY_*`-Variablen plus
  README-Snippet für User, die die kürzeren Defaults opfern wollen
- **Speicher bei großer History**: 166 MB bei 2430 echten Entries. Vor
  Release mit 20k echten Entries messen; falls nötig daemon-seitigen
  Entry-Cap unter `MAX_HISTORY_ENTRIES` einführen
- **Daemon-Lifecycle-Kanten** (Socket-Stale, doppelter Spawn, Version-Skew):
  Mitigation Pidfile + flock beim Spawn, `ping`-Versionsvergleich

---

## Umsetzungsprotokoll

### Abweichungen vom Plan (bewusst)

| Plan | Umsetzung | Grund |
|---|---|---|
| Wire-Format TSV, Details offen | `<op>\t<id>\t<protocol>\t…`, Antwort-Block bis Leerzeile; Escape-Set `\\ \t \n \r`; Decode in zsh via `${(g::)}` | `${(g::)}` löst genau dieses Set einpassig auf — kein Fork, keine Zeichen-Loop. Per Cross-Language-Parity-Test festgenagelt |
| `predict` liefert Kandidaten | Header trägt zusätzlich den Handle der exakten Zeile | Badge ohne zweiten Roundtrip |
| `predict` liefert alle Kandidaten | Request hat ein `limit`-Feld (Ghost: 1, Menü: 10) | 50 Zeilen pro Keystroke lesen ist Verschwendung |
| Ops: ping/predict/learn/names/shutdown | zusätzlich `names resolve` und `search` | Enter-Expansion braucht exakte Auflösung, `^Xq` braucht Fuzzy-Suche (nutzt `repl/history-search.ts` weiter) |
| Names-Änderung → Full Rebuild | `NameIndex.reset()` mutiert in place, kein Rebuild | Predictor hält den Index per Referenz; 130 ms Rebuild pro fremdem Handle wären unnötig |
| Dropdown auf Tab | Tab = Accept, Menü auf `^Xv` | Tab kann nicht gleichzeitig akzeptieren und ein Menü öffnen. compsys bleibt unangetastet |
| `^Xq` = incrementeller ZLE-Loop | Minibuffer-Query + Trefferliste via `zle -M`, bester Treffer in den BUFFER | Der volle Loop war als riskantestes Feature markiert; diese Stufe ist nutzbar und klein. Incrementell bleibt offen |
| Socket-Pfad `$XDG_RUNTIME_DIR` | dito, plus Ownership-/Symlink-/Modus-Prüfung des Verzeichnisses | `/tmp` ist world-writable: ein vorab angelegtes `/tmp/tabcat-<uid>` eines anderen Users würde jede getippte Zeile abfangen |
| — | `TABCAT_SOCKET` als Plugin-Override | Spiegelt `tabcat daemon --socket`, macht die pty-Tests deterministisch |
| Autostart beim ersten Tab, „kurzer Retry" | Autostart beim **Plugin-Load**, fire-and-forget (`TABCAT_WARM_ON_LOAD=1`); on-demand-Spawn wartet nur noch 60 ms | Gemessen: ein kalter Daemon braucht ~0,3 s bis er lauscht. Auf einen Tastendruck gewartet wäre das spürbar; beim Shell-Start kostet es 14 ms und ist fertig, bevor jemand tippt |
| CLI-Startzeit egal | `runRepl` wird dynamisch importiert | `dist/cli.js` zog Ink + React auch für `tabcat daemon` mit: 260 ms → 125 ms Startzeit |

### Bugs, die die Tests gefunden haben

Alle in der Implementierung, nicht in den Tests:

1. **`exec … 2>/dev/null` leitet die stderr der *ganzen* Shell dauerhaft um.** Der erste fd-Drop hätte jede weitere Fehlermeldung der Usershell verschluckt. Fix: Redirection in `{ … } 2>/dev/null` kapseln
2. **`${${(z)line}[1]}` liefert das erste *Zeichen*, nicht das erste Wort** — `hist_no_store` hätte nie gegriffen. Fix: Array-Kontext
3. **`int()` ist keine zsh-Mathfunktion** (braucht `zsh/mathfunc`) — der Timestamp blieb 0, der Daemon lehnte jedes `learn` ab. Fix: Truncation über `integer`-Deklaration
4. **`zselect` beendet mit Status 1, wenn der Timeout ausläuft** — das war der Normalfall in der Spawn-Warteschleife, `|| return 1` brach nach dem ersten Versuch ab
5. **`menu-select` existiert ohne `zsh/complist` nicht** — `zle -C` warf beim Laden einen Fehler in jeder `zsh -f`-Umgebung
6. **Widget mit Rückgabewert ≠ 0 lässt zle piepen** — „kein Vorschlag für diese Zeile" quittierte jeder Tastendruck mit einem Beep
7. **`zsystem flock` nimmt einen Dateinamen, keinen fd** (`-f var` liefert den fd zurück) — das Spawn-Lock schlug immer fehl, jede Shell hielt sich für den Verlierer und startete nie einen Daemon
8. **`zsystem flock` erstellt die Lock-Datei nicht** — auf einer frischen Maschine scheiterte damit der allererste Spawn
9. **Der gespawnte Daemon starb am SIGHUP der Shell, die ihn startete** — er kann während des Node-Starts noch keinen Handler installieren. Jetzt `nohup … &!`

Beim ersten echten Dogfooding kamen weitere dazu:

10. **`^Xd` war nie frei** (`_list_expansions` aus compinit) — in der Frei-Liste stand `d` nicht, ich hatte es beim Vorschlag trotzdem genommen. Menü liegt jetzt auf `^Xv`
11. **Zweimal Sourcen der `.zshrc` machte den Tab-Fallback rekursiv**: der zweite Durchlauf merkte sich `tabcat-tab` als „vorheriges" Tab-Widget. Persistenter State wird jetzt ohne Wert deklariert (`typeset -g` statt `typeset -g X=''`), Bindings, die schon uns gehören, gelten als frei — Re-Sourcing ist idempotent und warnt nicht mehr
12. **Ghost widersprach dem Getippten**: bei einem korrigierenden Kandidaten (`cd doc` → `Documents/`) wurde `insert` (`uments/`) angehängt, auf dem Bildschirm stand `cd documents/` — etwas anderes als Tab einfügt. POSTDISPLAY kann nur anhängen, also wird der Ghost in diesem Fall unterdrückt (Tab und `^Xv` bieten den Kandidaten weiter an)
13. **Badge kam zu spät**: nur bei exakter Zeilengleichheit. Jetzt in der Reihenfolge des REPL — getippte Zeile, dann die Zeile die der Top-Kandidat erzeugen würde (`acceptedLineFor`-Parität), dann Prefix-Treffer ab 2 Zeichen. Der Indikator erscheint, sobald das Getippte auf ein benanntes Kommando zuläuft
14. **Zwei Forks pro Tastendruck**: `$(_tabcat_header_handle)` und `$(_tabcat_ghost_for_candidate)` — Command-Substitution forkt eine Subshell. Beide setzen jetzt `REPLY`

### Testabdeckung

462 Tests, 31 Dateien. Neu:

- `tests/daemon/protocol.test.ts` — Escaping-Round-Trips (inkl. der Einpass-Falle), Feldzahlen, jeder Fehlercode
- `tests/daemon/engine-host.test.ts` — Tail-Follow, halb geschriebene Zeile, UTF-8 über die 64-KiB-Chunk-Grenze, Rebuild bei Inode-Wechsel/Truncate, „genau einmal gelernt", 126/127-Parität, Multiline, Read-only-History, Namen, Compaction + Offset-Reset
- `tests/daemon/server.test.ts` — Transcript-Tests über eine persistente Verbindung: Lifecycle, Warm-up, Idle-Exit, Stale-Socket, Doppelstart, Protokoll-Mismatch, Connection-Cap, Request-Größe, Cross-Process-Frische
- `tests/daemon/paths.test.ts` — sun_path-Fallback, Ownership, Symlink, Modus
- `tests/plugin/wire-parity.test.ts` — zsh-Encoder gegen `escapeField`, `${(g::)}` gegen `escapeField`, Socket-Pfad gegen `defaultSocketPath`, empty-preserving Split, `IFS= read`
- `tests/plugin/behavior.test.ts` — Privacy-Matrix, Buffer-Chirurgie, Chunk-Splitting, Nicht-interaktiv-Guard, Key-Bindings (inkl. „`^N`/`^R`/`^X`-Prefix unberührt"), precmd-Position vor einem Fremd-Hook, belegte Chords, autosuggestions-Konflikt
- `tests/plugin/integration.test.ts` — Plugin gegen echten Daemon (persistenter fd, Escaping Ende-zu-Ende, precmd-Learning, Namen, Suche) und gegen kaputte Daemons (Timeout, fremde id, Protokoll-Mismatch, warming)
- `tests/plugin/zpty.test.ts` — 8 Tests im echten Pseudoterminal: Ghost, Tab-Accept, Chunk-Accept, Shift+Tab-Undo, compsys-Fallback, Enter-Expansion, Badge, Learning, Privacy. Assertions über ein Probe-Widget und Dateisystem-Seiteneffekte statt Terminal-Scraping
- `tests/plugin/init.test.ts`, `tests/cli-daemon.test.ts` — Preflight-Check und CLI Ende-zu-Ende (`plugin init`, `daemon status|stop`, Doppelstart, `simulate --json`)

Zwei Fallen beim Testen, die dokumentiert bleiben sollen:

- **`spawnSync` + In-Process-Daemon = Deadlock.** Der blockierte Event-Loop kann nicht antworten, während zsh auf die Antwort wartet. Deshalb `runZshAsync` für alles, was den Daemon braucht
- **pty-Ausgabe nicht scrapen.** Der Redraw-Strom besteht zur Hälfte aus Cursor-Bewegungen; ein Probe-Widget, das `$BUFFER`/`$POSTDISPLAY` in eine Datei schreibt, ist exakt und stabil

### Offen

- `^Xq` incrementell (Live-Filterung während des Tippens)
- oh-my-zsh/antigen/zinit als Paket (`plugins=(tabcat)`); das Source-Snippet funktioniert in einer omz-`.zshrc`
- Speichermessung mit 20k echten Entries — bei 2430 waren es 166 MB RSS; falls nötig daemon-seitiger Entry-Cap
