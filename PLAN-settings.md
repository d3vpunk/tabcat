# Plan: Settings — eine Datei, ein Schema, drei Oberflächen

> **Status: in Arbeit.** Schritte ① (Schema + Loader + Schreibpfad), ②
> (CLI + `:settings` + interaktiver Editor, live im REPL) und ③ (Wire-Op)
> umgesetzt; offen: ④ Gear-Panel, ⑤ Plugin-Fetch. Entwurf am
> 2026-07-27 gegen den Code geprüft: `:`-Dispatch (`run.ts:27`),
> `:`-Completion (`app.tsx:102`) und atomares Schreiben unter Lock
> (`store.ts:55`) existieren bereits — der Plan baut auf ihnen auf statt
> sie zu duplizieren.

## Ziel

Nutzer können tabcat konfigurieren — `repl.dropdownRows`, `repl.footer`,
GUI-Fensterbreite, Hotkey, später mehr — und zwar an drei Orten mit einer
Semantik: `tabcat settings` (CLI), `:settings` (REPL), Gear-Panel (GUI).

## Leitidee: das Schema rendert die UIs, nicht umgekehrt

Zukunftssicher ist nicht die Datei, sondern dass **eine Schema-Zeile alle
Oberflächen erzeugt**. Ein neues Setting = ein Eintrag in
`src/settings/schema.ts`, und es erscheint automatisch im CLI-Listing, in der
`:settings`-Ausgabe samt Key-Completion, im Gear-Formular (über die Leitung)
und in der Validierung. Handgebaute Formulare pro Oberfläche wären die
`acceptedLine`-Verdreifachung als Dauerzustand — drei Stellen, die bei jedem
Setting nachziehen müssen.

Schema-Eintrag: `key`, `type` (`bool | int | enum | string | hotkey`),
`default`, Constraints (`min`/`max`, `options`), `label`, `description`,
`appliesLive`. Aus `appliesLive: false` machen die UIs einen sichtbaren
Hinweis „wirkt ab nächster Shell / Neustart" — ehrlich anzeigen statt halb
anwenden (Plugin-Keybindings sind der klare Fall: gebunden beim Load).

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Datei | `settings.json` als Sibling von `history.jsonl` (`settingsFileFor`, gleiches Muster wie `namesFileFor`) — Tests bekommen Isolation geschenkt |
| Format | JSON. Node nativ, Swift `Codable` nativ, null neue Dependencies. TOML/YAML bräuchte einen Swift-Parser; zsh liest die Datei ohnehin nie |
| Inhalt | **Sparse** — nur Abweichungen vom Default. Fehlender Key = Default, fehlende Datei = alles Default. Neues Setting braucht keine Migration |
| Unbekannte Keys | Tolerieren + Warnung (alte Binary liest neuere Datei). Beim Schreiben **erhalten** (Raw-JSON mutieren, nie durch typisierte Struktur round-trippen) |
| Invalider Wert | Warnung + Default, nie Crash — „die Shell des Users darf nie hängen" gilt auch hier |
| Kaputtes JSON | Lesen: Defaults + Warnung. **Schreiben: Fehler statt Überschreiben** — eine handeditierte Datei mit Tippfehler darf kein `set` wegwerfen |
| Präzedenz | Default < `settings.json` < env `TABCAT_*` < CLI-Flag. Env bleibt Override-Kanal (Tests, Per-Shell-Notausgänge wie `TABCAT_GHOST=0`) |
| Reset | **Key löschen, nicht Default schreiben.** Sonst friert das erste Öffnen des Gear-Panels alle Defaults als User-Entscheidungen ein und kein künftiger Default-Wechsel erreicht je einen Nutzer |
| Schreibpfad | Einer: Lock (`proper-lockfile`, Muster `store.ts`) → Raw-JSON mutieren → tempfile + rename. CLI, REPL und Daemon nutzen dieselbe Funktion |
| Settings ≠ State | Datei ist **Intent** (handgeschrieben, diffbar, kopierbar). Fensterposition, Rail-Inhalt, Runs-Ablage bleiben in `UserDefaults`/eigener Ablage — sonst überschreibt die App Hand-Edits |
| Consumer-first | Ein Key kommt erst ins Schema, wenn sein Consumer ihn liest. Ein Setting, das nichts tut, ist ein gebrochenes Versprechen im Listing |
| Propagation | Pull, kein Push. Eigener Editor wendet sofort an; fremde Prozesse holen per mtime (GUI beim Launcher-Öffnen, REPL optional per stat im Prompt-Zyklus). Kein `fs.watch` (plattform-flaky), kein Push über den Socket (Request/Response) |
| Versionierung | Kein `version`-Feld. Sparse + tolerant macht Migrationen fast immer überflüssig; ein Key-Rename bekäme eine Alias-Map im Schema |

## Komponenten

### 1. Schema + Loader + Schreibpfad (`src/settings/`) — ✅ Schritt ①

- `schema.ts` — `SETTINGS`-Tabelle (discriminated union pro Typ),
  `validateValue` (JSON-Wert gegen Spec), `parseInput` (getippter Text aus
  CLI/`:settings`, z. B. `"8"`, `"true"`). Fehlermeldungen nennen die
  Erwartung („expected an integer between 1 and 20").
- `store.ts` — `readSettings`: Defaults + Datei-Overrides zu effektiven
  Werten mergen, `overridden`-Set (nur dafür gibt es „Zurücksetzen"),
  `warnings` als Rückgabe (Caller entscheidet über die Ausgabe — Muster
  `onSkipped` in `readHistory`). `writeSetting`/`clearSetting` unter Lock,
  atomar, unknown-preserving; `clearSetting` prunt leere Sektionen.
- Gelesen wird verschachtelt **und** flach: `{"repl":{"footer":false}}` und
  `{"repl.footer":false}` meinen denselben Key (der Flatten-Walk gibt das
  gratis her); der Writer normalisiert auf verschachtelt und räumt die flache
  Schreibweise dabei weg.
- Erste Keys: `repl.dropdownRows` (int 1–20, Default 5, heute Konstante
  `app.tsx:11`), `repl.footer` (bool, Default true — die Legende unter dem
  Prompt). GUI-Keys folgen mit Schritt ④ (Consumer-first).

### 2. CLI + `:settings` — ✅ Schritt ②

- `tabcat settings [list]|get|set|reset` — Listing zeigt Key, effektiven
  Wert, Default-Marker (`*` = geändert), Beschreibung; `get` druckt nur den
  Wert (scriptbar). Shape-Validierung in `cli-args.ts`, Key-Existenz beim
  Schema in `cli.ts` — die Args-Schicht bleibt schemafrei.
- REPL: Dispatch von `^:(\w+)$` auf `:cmd [args]` erweitert — **nur**
  `:settings` nimmt Argumente, `:help foo` bleibt wie bisher unhandled.
  `:settings` druckt die Tabelle (`ReplOutput`-Kind `settings`),
  `:settings <key> <value>` setzt, `:settings reset <key>` löscht den
  Override; Bestätigungen und Fehler als generisches `note`-Kind. **Kein
  Formular-Modus** — `settingsHints` (app.tsx) speist die normale
  `:`-Completion: nach `:settings ` kommen die Keys, nach einem bool/enum-Key
  die Werte, alles aus dem Schema gerendert.
- Live-Apply: `runRepl` liest die Settings beim Start (Warnungen einmalig auf
  stderr) und nach jedem Write (`onSettingsChanged`) neu — `dropdownRows` und
  `footer` gehen als Props in `promptOnce`, der nächste Prompt rendert neu.
  `repl.footer=false` übernimmt die Legend-Regel des Minimal-Modus:
  Key-Hilfe weg, Paste-/Search-Hinweise bleiben (sie sind Modus-UI).
- Geerbt: `:`-Zeilen laufen am Executor und am Learning vorbei
  (`run.ts` prüft vor `execute`) — Settings-Kommandos landen nie in
  `history.jsonl`.

### 2b. Interaktiver Editor im REPL — ✅

Bares `:settings` öffnet einen Ink-Editor statt der statischen Tabelle —
eigene Ink-Session zwischen zwei Prompts, dasselbe Muster wie `:meow`
(`ReplCommandResult` `'settings-ui'`, der Loop awaited `showSettingsEditor`
und liest danach neu). `:settings list` bleibt die statische Tabelle,
`:settings <key> <value>`/`reset` bleiben der schnelle Weg.

- **Pure State-Machine + dünner Wrapper** (`settings-ui-state.ts` /
  `settings-ui.tsx`) — das `prompt-state.ts`-Muster: der Reducer ist ohne
  Terminal testbar und gibt Effekte (`write`/`clear`) zurück, die der
  Wrapper ausführt. Schlägt der Write fehl (kaputtes JSON), zeigt der Editor
  den Grund und liest den echten Dateistand zurück, statt die Änderung
  vorzutäuschen.
- **Schema-getrieben:** bool = Space/Enter-Toggle, int = ←/→ geklemmt auf
  min/max, enum = ←/→ zyklisch, string/hotkey = Inline-Edit (Enter öffnet,
  Enter committet mit Validierung, Esc bricht ab). ⌫ = Reset (Key löschen,
  nur auf überschriebenen Zeilen). Esc/^C schließt. Neues Setting im Schema
  = neue Zeile, null Editor-Code.
- **Write-through:** jede Änderung schreibt sofort atomar — kein
  „Speichern"-Schritt, kein verlorener Zustand.
- Der Editor ist das REPL-Gegenstück zum Gear-Panel (Schritt ④): beide
  rendern dasselbe Schema, einer in Ink, einer in SwiftUI.

### 3. Wire-Op `settings` — ✅ Schritt ③

Flache Zeilen passen exakt ins TSV-Format, der Validator bleibt einer (das
TS-Schema im Daemon). Festes Sechsfeld wie bei `names`, ungenutzte Felder
leer:

```text
→ settings\t<id>\t<protocol>\t<list|set|reset>\t<key>\t<value>
← ok\t<id>                                          (list)
← <key>\t<type>\t<value>\t<default>\t<constraint>\t<label>\t<description>\t<live>\t<overridden>
← ok\t<id>\t<effektiver-wert>                       (set/reset)
← err\t<id>\tbad_value\t<message>
```

Abweichungen vom ursprünglichen Entwurf, mit Grund:

- **Kein Protokoll-Bump.** Eine neue Op ist additiv: alte Clients senden sie
  nie, ein neuer Client gegen einen alten Daemon bekommt `bad_op` und kann
  degradieren. Ein Bump hätte jedes alte Plugin gegen einen neuen Daemon
  stillgelegt — ohne Not.
- `reset` als dritte Sub-Op (das Gear-Panel braucht „Zurücksetzen").
- Zeilen tragen `description` und `overridden` statt `section` (ableitbar
  aus dem Key): das Panel ist das einzige Frontend mit Platz für
  Beschreibungen, und ohne `overridden` wüsste kein Client, ob Reset etwas
  täte.
- `bad_value` statt eines neuen `invalid_value`-Codes — der Code existiert.
- Kein Warming-Guard: Settings berühren den Predictor nicht, das Panel
  rendert auch während des Model-Builds. Shape-Prüfung im Parser
  (`protocol.ts`), Key-Existenz im Server — dieselbe Schichtung wie
  cli-args/cli. Parser-Kommentar hält die Additiv-Regel fest.

### 4. GUI: Gear + schema-getriebenes Panel — Schritt ④

- Das GUI dupliziert das Schema **nicht** — es holt es über `settings list`
  und rendert Controls nach Typ: bool = Toggle, int = Stepper mit Range aus
  `constraint`, enum = Picker, hotkey = Recorder. Ein unbekannter Typ rendert
  generisch — GUI-Binary und tabcat-Version dürfen auseinanderlaufen, den
  Skew handhabt `ping` ohnehin.
- Ausnahme Boot-Pfad: `gui.launcherWidth` und `gui.hotkey` braucht die App
  vor dem Daemon-Connect — die zwei liest sie direkt aus der Datei (Codable,
  Defaults in Swift). Drift abgesichert per Cross-Language-Parity-Test nach
  dem Vorbild von `wire-parity.test.ts`: TS dumpt die effektiven Defaults,
  die Swift-Seite ihre, CI vergleicht.
- Präsentation: Gear klein neben dem Wordmark; Klick tauscht die
  Kandidatenliste gegen die Settings-Ansicht im selben Glas — kein zweites
  Fenster, kein Activation-Tanz mit dem nonactivating Panel. Escape schließt
  die Ansicht: neue oberste Sprosse der bestehenden Escape-Leiter.
- Das Panel ist bewusst Kontrollzentrum für **alle** Namespaces (auch
  `repl.*`, `plugin.*`) — das einzige Frontend mit Platz für Beschreibungen.
- Mit diesem Schritt kommen `gui.launcherWidth` (heute Konstante
  `Layout.swift:20`) und `gui.hotkey` (heute env + `UserDefaults`-Key
  `hotkey`, `HotKey.swift:42` — der UserDefaults-Key ist Intent und wandert
  in die Datei; env bleibt Override) ins Schema.

### 5. Plugin-Fetch — später

Das Plugin liest die Datei nie (zsh parst kein JSON; `tabcat settings
export` pro Shell-Start wäre ein Node-Kaltstart ~106 ms — genau das, was der
Daemon vermeidet). Stattdessen: beim ersten Connect einmal `settings list`
über den persistenten fd (0,027 ms) und nur die Vars setzen, die der User
nicht schon per env gesetzt hat (vor dem `: ${VAR:=…}`-Defaulting merken,
welche unset waren). Bis dahin bleibt env das Plugin-Interface — das
Präzedenz-Modell trägt beides.

## Tests

- **Schema-Metatest:** jeder Default besteht seine eigene Validierung, Keys
  eindeutig — pinnt jede künftige Schema-Zeile automatisch.
- **Store:** Round-Trip, Sparse-Invariante (Datei enthält nur den gesetzten
  Key), Reset + Sektions-Pruning, unbekannte Keys überleben fremde Writes,
  kaputtes JSON (Lesen weich, Schreiben hart), flache Schreibweise,
  Rechte 0600/0700.
- **Parity (ab ④):** TS-Defaults gegen Swift-Defaults im CI.
- **Transcript (ab ③):** `settings list/set` über den Socket, invalide Werte
  als `err`-Antwort.

## Reihenfolge

1. ✅ **Schema + Loader + Schreibpfad** (`src/settings/`, Tests)
2. ✅ **CLI `tabcat settings` + `:settings`** — kleinster Ende-zu-Ende-Beweis:
   `repl.dropdownRows` + `repl.footer` wirken live
3. ✅ **Wire-Op** (Transcript-Tests; ohne Protokoll-Bump, s. o.)
4. **Gear-Panel** (schema-getrieben, Boot-Pfad-Keys, Parity-Test)
5. Plugin-Fetch, weitere Keys (`plugin.*`, `engine.*`) — jeweils mit ihrem
   Consumer

## Risiken

- **Defaults doppelt (TS + Swift) im Boot-Pfad** — bewusst klein gehalten
  (zwei Keys) und per Parity-Test gepinnt; alles andere kommt über die
  Leitung.
- **Gear-Panel im nonactivating Panel**: Formular-Controls brauchen
  Key-Fokus; die Escape-Leiter und der First-Responder-Tanz sind die
  bekannten Kanten (vgl. Phase-5-Erfahrungen im GUI-Plan). Mitigation:
  gleiche Ansicht statt zweites Fenster, Fokus-Regeln aus Phase 5
  wiederverwenden.
- **Settings, die Parität brechen**: `engine.*`-Keys wirken je nach Prozess
  (laufender Daemon vs. frisches REPL) zeitversetzt — `appliesLive` ehrlich
  setzen und im Listing zeigen, sonst „wundert sich das Ranking".
