# Plan: macOS-Overlay — vom Prototyp zum Interface

> **Status: offen.** Der Befund ist am 2026-07-26 gegen den Code geprüft. Das
> Overlay funktioniert, aber es ist ein Textfeld mit Ghost, kein Interface. Dieser
> Plan sagt, was es stattdessen wird und in welcher Reihenfolge.

## Der Ausgangsbefund

Das Overlay nutzt ein Drittel des Protokolls, das es bereits spricht.

| Op | Kann | GUI nutzt heute |
|---|---|---|
| `predict` | n Kandidaten mit Ranking, Quelle, Merge | `limit: 1`, nur Ghost (`PromptModel.swift:183`) |
| `search` | Fuzzy-History; leerer Query = letzte Befehle | nichts |
| `names create` / `delete` / `list` | Handles anlegen, löschen, auflisten | nur `resolve` (`PromptModel.swift:333`) |
| `cwds` | Verzeichnis-Ranking per Frecency | ja |

`server.ts:297` und `server.ts:329` sind gebaut, getestet und ungenutzt. Das
Overlay ist nicht roh, weil Engine-Arbeit fehlt — es ist roh, weil das Frontend
an einer fertigen Engine vorbeiredet.

---

## Leitidee

**Die Modi des REPL sind Zwänge eines Terminals, keine Features zum Portieren.**

Ein Terminal-Prompt hat eine Zeile und eine Zeichenebene. Jeder Modus in
`prompt-state.ts` löst einen Konflikt, der daraus entsteht. Fällt der Zwang weg,
fällt der Modus weg — ersatzlos, nicht ersetzt:

| REPL-Modus | Warum er existiert | Im GUI |
|---|---|---|
| `searchQuery` (^R) | kein zweiter Ort für ein Suchfeld | Tippen filtert den Ergebnisraum |
| `historyFilter` + die ↑-Fallunterscheidung (`prompt-state.ts:485-532`) | eine Taste, zwei Listen, eine Zeile | eine Liste, kein Konflikt |
| `pasted` | Prompt ist einzeilig | Feld wächst mit |
| `naming` (friert die Zeile ein) | kein zweiter Ort fürs Badge | Popover neben der weiterhin sichtbaren Zeile |
| `undoStack` + ⇧Tab | Terminal hat kein ⌘Z | ⌘Z, im TextView geschenkt |

Fünf Zustände weniger. Das ist der grösste Anteil an „flüssig" — nicht mehr
Tasten, sondern weniger Zustände.

**Was für Wiedererkennung bleibt:** `❯`, Tab als Accept, ⚡ für Handles, die
Chip-Reihe mit ⌥-Cycling, ⌘↓ zum Wegschicken, ⌘⏎ für Zurückgehaltenes.

---

## Entschieden

**Enter ist zweistufig.** Enter auf einer per ↑/↓ gewählten Listenzeile füllt die
Prompt-Zeile, Enter danach führt aus. Es ist immer sichtbar, was gleich läuft, und
ein Enter zu früh startet nichts. Auf der ungewählten Liste (`selected == 0`, also
direkt nach dem Tippen) führt Enter die getippte Zeile aus — wie heute.

**Runs sind echte Objekte.** Sie überleben den Neustart, sind durchsuchbar, wieder
ausführbar, ihre Ausgabe ist kopierbar, sie sind nachträglich benennbar, und es
gibt „in Terminal öffnen" als Ausgang. Eigene Ablage neben `history.jsonl`; die
Grenze zum Repo bleibt intakt, weil das GUI-eigener Zustand ist und über keinen
neuen Kanal geht.

---

## Neu, weil ein GUI es kann

**Die Merge-Grenze zeigen.** tabcats Kernalgorithmus stoppt Tab an der ersten
echten Gabelung (`merge.ts:22`). Im Terminal lernt man das nur durch Drücken. Hier
wird es gezeichnet: Ghost bis zur Stopp-Position kräftiger, danach schwächer, plus
Marke. Macht aus unsichtbarer Magie etwas Lesbares — das ist der stärkste Grund,
überhaupt ein GUI zu bauen.

**Detail ohne Auswahlbewegung.** `·fs` und `·✓` waren Kompression aus Platznot.
Die gewählte Zeile (und Hover) zeigt: voller Befehl, Häufigkeit, letzte Nutzung,
Lernverzeichnis, Handle.

**Konsequenz statt Warnung.** `HazardScan` sagt „löscht ganze Verzeichnisbäume".
Gerechnet und gezeigt wird daraus `node_modules — 41.203 Dateien, 812 MB`; bei
`git reset --hard` die Liste der Dateien, die verloren gehen. Aus einem Dialog,
den man wegklickt, wird Information, die man liest.

**Validierung vor Enter.** Programm auf `$PATH`, Pfadargument vorhanden. Der
Daemon hat die fs-Completion bereits.

**Zeit.** Laufzeit auf der laufenden Card, „vor 3 min" an der History-Zeile.

---

## Phasen

Reihenfolge nach Abhängigkeit, nicht nach Aufwand. Was der Rehaul ohnehin
wegwirft, wird vorher nicht repariert.

### Phase 0 — Bugs, die den Rehaul überleben ✅

Erledigt am 2026-07-26. Ghost-Drift (`PromptView.swift`) und das tote Tab bei
korrigierenden Kandidaten (`Engine.swift:78`) bleiben liegen: das ist Prompt-Kern
und gehört in Phase 2, sonst wird zweimal gearbeitet.

1. **Rail-Überlauf killt einen laufenden Prozess** — `PromptModel.swift:270`
   ruft `dropped.terminate()` ohne Vorwarnung. Laufende Runs dürfen nicht aus der
   Rail fallen; stattdessen wächst die Rail oder der Überlauf wird sichtbar
   gestapelt.
2. **Badges lassen sich nicht schliessen** — `OverlayContent.swift:37` bindet nur
   `bringToFront`, `RunCard` hat keinen Close. Das GUI-README behauptet das
   Gegenteil; entweder der Knopf kommt oder die Zeile geht.
3. **Geister-Overlay** — `OverlayPanel.swift:41` ordert per `cancelOperation`
   aus, ohne `launcherVisible` zu setzen; `main.swift:98-101` holt es bei der
   nächsten beliebigen Modelländerung zurück auf den Schirm.
4. **Panel bleibt key nach `hideLauncher`**, solange Runs existieren
   (`main.swift:84`). Ein nonactivating Panel, das key ist, bekommt Tastendrücke
   systemweit — ohne First Responder werden sie geschluckt. Fix: beim Verstecken
   `orderOut` + `orderFront`, damit die Rail sichtbar bleibt, ohne key zu sein.
   **Laufend verifizieren**, die Ableitung ist aus der API-Semantik, nicht gemessen.
5. Nachgereicht: `Text("exit \(code)")` mit `code: Int32?` zeigte einen Fehlschlag
   als `exit Optional(1)` und einen unbekannten Ausgang als `exit nil`, weil
   `nil != 0` in Swift wahr ist.

### Phase 0b — Das Overlay fand `tabcat` nicht ✅

Erledigt am 2026-07-26, gemessen statt vermutet.

Ein gebündeltes `.app` erbt launchds PATH — `/usr/bin:/bin:/usr/sbin:/sbin`. Auf
dieser Maschine liegt `tabcat` unter `~/.nvm/versions/node/v20.19.0/bin`, also
scheiterte `resolveSocketPath`, `client` blieb nil, jede Prediction kehrte vor dem
Senden zurück, der Ghost war strukturell leer — und damit war Tab per Konstruktion
wirkungslos. Die Chip-Reihe zeigte trotzdem etwas, weil der git-Seed einsprang und
das Versagen verdeckte. `--check` sah es nie, weil eine Diagnose aus dem Terminal
läuft.

Die Datei zu finden reichte nicht: `tabcat` ist ein Node-Script, und `node` fehlt
auf demselben PATH — exit 127. `ToolPath` fragt deshalb die Login-Shell nach
Binary **und** PATH und probt mit `daemon path`, ob es wirklich läuft. `--check`
meldet das Binary als erste Zeile.

Ausserdem: Tab und → lagen an `.onKeyPress` auf dem Feld, wo der Field-Editor sie
vorher als `insertTab:` und `moveRight:` abfängt. Sie liegen jetzt im lokalen
Event-Monitor, wo schon die ⌘-Ziffern liegen und aus demselben Grund.

### Phase 0d — Akzeptieren nimmt den Kandidaten, nicht den Ghost ✅

Erledigt am 2026-07-26, ausgelöst durch einen Bericht aus dem Betrieb: getipptes
`lint` zeigte den ⚡-Badge, Tab tat nichts.

Der Badge war der Beweis, dass alles da war. `handleHint` liefert ihn über
`acceptedLine`, also stand der magic-Kandidat auf Platz 0. Nur:
`ghostText` verlangt, dass `display` mit dem Getippten beginnt — bei einem Handle
ist `display` das aufgelöste Kommando, das nie mit dem Handle anfängt. Ghost leer,
und `acceptGhost()` guardete auf `!ghost.isEmpty`.

Der Fehler war konzeptionell: **der Ghost ist Darstellung, der Kandidat ist die
Sache.** `acceptedLine(for:line:)` steht jetzt neben `ghostText` in `Engine.swift`
und ersetzt die letzten `replace` Codepunkte durch `display` — dieselbe Regel wie
`acceptedLine` in `server.ts` und `acceptedLineFor` in `app.tsx`. Damit
funktionieren Handles **und** korrigierende Kandidaten (`doc` → `Documents/`).

Enter löst einen bar getippten Handle auf, wie im REPL (`prompt-state.ts:453`) und
im Plugin. Die `@handle`-Syntax ist raus — sie existierte nur, weil der normale Weg
kaputt war. Vorschau-Zeile `⇥ <ergebnis>`, solange kein Ghost es zeigen kann;
verschwindet mit der Ergebnisliste in Phase 1.

`accepting: 7/7` in `--check`, inklusive des Emoji-Falls, an dem UTF-16-Zählung
scheitern würde.

Bleibt offen bis Phase 1: mit `limit: 1` gibt es nichts zum Durchtippen, also ist
Tab auf einem bereits vollständigen Kandidaten eine tote Taste statt eines Cycles.

### Phase 0c — Verzeichniswechsel ✅

Erledigt am 2026-07-26.

`cd frontend` startete eine frische `zsh -ic`, das Kind wechselte sein Verzeichnis
und starb: leere Card, nichts geändert. Nicht fehlend, sondern irreführend.

Zwei Ebenen, absichtlich getrennt:

- **Allgemein:** jeder Run meldet am Ende sein `pwd` in eine Temp-Datei und der
  Prompt übernimmt es (`Run.wrapped`, exakt der Trick aus `executor.ts:137`). Damit
  bewegen `cd x && make`, `z api`, `pushd` und jeder rc-definierte Wrapper den
  Prompt, ohne dass irgendwer sie erkennen muss. Übernommen nur, wenn der Prompt
  noch dort steht, wo der Run startete — sonst reisst ein Hintergrund-Run den User
  zurück.
- **Abkürzung:** `Navigation` erkennt vorab, was nur bewegt — `cd`, `cd -`,
  `cd <pfad>` und ein blosser Pfad — löst in Swift auf (eine interaktive Shell
  kostet ~2,6 s, Navigation muss sich nach Bewegen anfühlen) und macht gar keine
  Card. Existiert das Ziel nicht, steht es am Prompt und die Zeile bleibt stehen.

`PromptModel.cwd` ist dafür von der Chip-Auswahl abgeleitet zu gespeichert
geworden; `selection` ist jetzt `Int?` und nil, sobald der Prompt irgendwo steht,
das die Reihe nicht listet. Die Pfadzeile ist eine klickbare Breadcrumb, Chips
sind klickbar, und ein Refresh setzt das Verzeichnis nicht mehr zurück.

Beide Tabellen hängen in `--check` (`navigation: 17/17`, `run reports its final
directory`), nach dem Muster von `hazards`/`exitStatus` — die Navigationstabelle
hat sofort gefangen, dass `cd -` als einziger Pfad nicht normalisiert wurde und
ein Schrägstrich am Ende den Chip-Abgleich still gebrochen hätte.

**Folge, die jetzt sichtbar wird:** `cwdBoost` (`model.ts:189`) und Handles
(`names.ts:63`) matchen per exaktem String. Wer nach `frontend` wechselt, verliert
Projekt-Boost und alle im Elternverzeichnis angelegten Handles. Steht als Befund
in `PLAN-cwd-cold-start.md`, war aber folgenlos, solange niemand bequem in
Unterordner wechseln konnte. Präfix-Vererbung in der Engine ist damit fällig —
eigener Schritt, TypeScript-Seite.

### Phase 1 — Ergebnisraum (Vorhersage ✅, Rest offen)

**Erledigt am 2026-07-26:** die Liste selbst, gespeist aus `predict`
(`limit: 6`). ↑/↓ läuft durch (über den Event-Monitor, der Field-Editor frisst
Pfeile sonst), Enter ist zweistufig, Tab und → nehmen die **ausgewählte** Zeile,
ein Klick auf eine Zeile füllt sie ein. Getippter Präfix dim, `·fs`/`·✓` wie im
REPL, magic-Zeilen mit ⚡ Handle plus Auflösung.

Auf leerer Zeile wird ebenfalls gefragt — das ist die Frecency-Rangliste des
Verzeichnisses. Der Guard davor behauptete in seinem eigenen Kommentar, der
Daemon lehne leere Zeilen ab; `protocol.ts` lehnt nur ein leeres `cwd` ab. Der
Launcher öffnet jetzt mit „was du hier üblicherweise tust" statt mit nichts.

`launcherSize.height` von 300 auf 440, und `launcher` hängt jetzt an seiner
**Oberkante** statt an der Unterkante — der Inhalt hängt oben, also muss diese
Kante stehenbleiben, wenn die Box wächst.

Nachgezogen am selben Tag: `limit: 0` statt sechs — sechs über die Leitung zu
holen war ein unsichtbarer Deckel, die Liste hätte an Zeile 6 geendet ohne zu
sagen, dass sie geschnitten wurde. Sechs Zeilen sichtbar, echter ScrollView statt
des REPL-Schiebefensters (Rad und Trackpad gratis, Auswahl wird hineingescrollt),
Zähler ab der siebten.

**Nachgezogen nach einem Screenshot vom Laptop: die Run-Card lag auf der
Kandidatenliste.** Nicht zu wenig Platz, sondern die falsche Bezugskante. Der
Launcher hing 170 pt über der Mitte, also war seine Unterkante auf jedem Schirm
gleich tief; auf 907 pt sichtbarer Höhe blieben darunter 344 pt für eine Card, die
260 hoch sein wollte und ihre Sollposition per `max(minY + margin, …)` nach oben
verschoben bekam — 40 pt in das Glas hinein. Der Clamp verschob, statt zu
schrumpfen, und das war so kommentiert.

Vier Änderungen, eine Regel: was passen muss, liegt **unter** dem Prompt, also
wird von oben gemessen.

- Oberkante ein Drittel von oben, und höher, wenn ein Drittel nicht reicht — der
  Stapel endet am unteren Rand statt dahinter.
- `launcherSize` gibt Höhe ab, damit `minimumCardHeight` (140) darunter frei
  bleibt. Auf 1024×600 ist die Box deshalb 398 statt 440.
- `card(below:)` schrumpft auf das, was übrig ist, statt zu schieben. Und misst
  ungeklemmt: die Klemmung auf die Boxhöhe hiess, dass ein Glas, das über seine
  eigene Box wächst (Confirm-Card), die Card nicht weiterschiebt, sondern sie
  überlappt.
- `panelOpen` nimmt die ganze Fläche, in der eine Card landen kann, statt eines
  Rechtecks für eine geratene Höhe. Das Frame ist damit unabhängig davon, wie hoch
  SwiftUI das Glas gerechnet hat.

Die Tabelle in `--check` hat den Fall nicht gehabt: sie prüfte „auf dem Schirm"
und „im Panel", nie „nicht auf dem Launcher". Jetzt sechs Schirme statt vier
(dazu der Laptop als `visibleFrame`, also ohne Menüleiste, und ein Portraitschirm)
und die Überlappung gegen fünf Glashöhen von 240 bis Box + 60.

**Offen:** `search` (History) und `cwds` in dieselbe Liste, sektioniert; die
Detailspalte rechts. Erst damit fallen ^R und der History-Modus endgültig weg.

### Phase 2 — Prompt-Kern (Tastenparität ✅, Textfeld offen)

**Erledigt am 2026-07-26**, nach der Vorgabe „es muss sich anfühlen wie der REPL,
ausser es gibt gute Argumente":

- Tab akzeptiert, und schaltet weiter wenn nichts anzunehmen ist
  (`prompt-state.ts:163`). Betrifft jedes fertig getippte Kommando — `insert` ist
  dann leer.
- → nimmt **einen Chunk**, nicht den ganzen Vorschlag. Approximation über den
  Ghost wie im Plugin (`tabcat.plugin.zsh:667`), nicht der Lexer: der lebt in
  TypeScript, und eine dritte Sprache, die ihn nachbaut, wäre ein drittes Ding zum
  Synchronhalten. Nur wo ein Ghost existiert — ein korrigierender oder
  auflösender Kandidat ersetzt, und ein halbes Ersetzen ist kein kleineres
  Ersetzen. `chunking: 7/7` in `--check`, gegen das Plugin gelesen.
- ⇧Tab macht den letzten Accept rückgängig, mit derselben Ankerregel wie der REPL
  (`prompt-state.ts:300`): Tippen nach einem Accept legt die akzeptierte Zeile als
  eigene Ebene an, sonst frisst ⇧Tab die getippten Zeichen mit. Eigener Stack statt
  ⌘Z, das eine Änderung über das Binding gar nicht sieht.

**Nachgezogen am selben Tag: eigenes `NSTextView` (`PromptField`).** Vier Probleme,
die alle dieselbe Ursache hatten — Ghost und Caret müssen aus **einem** Layout
kommen:

- Der Ghost war ein eigenes `Text`, verschoben um die gemessene Breite des
  Getippten. Richtig, bis die Zeile breiter als das Feld wurde: das Feld scrollt
  seinen Inhalt, ein fester Offset nicht. Jetzt im View gezeichnet, und der Text
  bricht um statt seitlich zu scrollen — auf 800 pt bleibt das ganze Kommando
  lesbar, und ein Umbruch ist ohnehin das, was mehrzeilige Eingabe braucht.
- Die Caret-Position wurde aus dem Field-Editor herausgefischt, und Prediction
  fragte immer nach dem Zeilenende. Jetzt echt: `acceptedLine(for:line:caret:)`
  spleisst am Cursor, was dahinter steht überlebt.
- Mehrzeilig ohne Modus: ⌥Enter fügt eine Zeile ein, ein Paste mit Umbrüchen
  ebenso. Der REPL braucht dafür `pasted` samt eigener Vorschau, weil ein
  Terminal-Prompt eine Zeile hat.
- Die Editor-Tasten liegen jetzt in `doCommandBy` des Textfelds statt im globalen
  Event-Monitor. Dort gehören sie hin — der Monitor war die Umgehung dafür, dass
  der Field-Editor sie vorher wegnahm. Im Monitor bleiben nur noch ⌘-Kombinationen
  und das ⌥-Cycling.

**Zur „sichtbaren Merge-Grenze" — die Idee war falsch gestellt.** Der Ghost *ist*
der Merge, er endet bereits an der Gabelung; „bis wohin Tab geht" wäre also die
ganze Länge und sagt nichts. Die Grenze, die etwas erklärt, liegt zwischen **→ und
Tab**: der erste Chunk wird eine Stufe heller gezeichnet als der Rest. Man sieht,
was die eine Taste nimmt und was die andere.

**Offen:** ^W/^U und Chunk-Löschen (`^⌫`); `sizeThatFits` rechnet den Ghost nicht
mit, ein Ghost der die letzte Zeile überläuft könnte also beschnitten werden.

### Phase 2 — Prompt-Kern

`TextField` raus, eigenes `NSTextView`: Ghost und Caret brauchen dieselbe
Layoutquelle, sonst driftet der Ghost bei langen Zeilen. Dann:

- Tab = ganzer Merge, → = ein Chunk (Approximation wie
  `tabcat.plugin.zsh:667`: führender Whitespace + Wort + folgender Whitespace,
  kein Lexer über die Sprachgrenze)
- Merge-Grenze sichtbar
- Korrigierende Kandidaten: kein Ghost, aber Tab nimmt sie an — wie das Plugin,
  anders als heute
- ⌘Z statt ⇧Tab
- mehrzeilige Eingabe ohne Modus
- ^W/^U/⌥⌫ ergänzen, was AppKit nicht geschenkt gibt

### Phase 3 — Handles

⌘N als Popover, ⌘⌫ zum Vergessen, beides über `names create`/`delete`. Magic-
Kandidaten als echte Listenzeile mit ⚡. Die `@handle`-Syntax
(`PromptModel.swift:330`) fliegt raus — sie existiert nur, weil der normale Pfad
kaputt ist.

### Phase 4 — Runs als Objekte

Ablage, Persistenz, Suche, Re-Run, Copy, „in Terminal öffnen", nachträgliches
Benennen. Keystrokes in die pty routen (termios regelt Echo, `sudo` verhält sich
wie im Terminal). Laufzeit auf der Card.

### Phase 5 — Launcher-Flow

Escape schliesst als letzte Stufe. Klick nach aussen schliesst. Freier Pfad neben
den Chips. `status` aufgeteilt: Fehler laut und eigenständig, „ready" unsichtbar
(`PromptModel.swift:116` überschreibt heute Fehler damit). Kontextsensitive
Tastenlegende. Verzeichnisauswahl übersteht das Wiederöffnen.

### Phase 6 — Testtarget

`Package.swift` hat heute nur das Executable; `--check` ist ein manuelles
Diagnosewerkzeug, kein Test. `HazardScan`, `ghostText`, `ExitStatus`, `Wire` und
der neue Prompt-Kern sind pure Funktionen und gehören gepinnt — die TS-Seite hat
462 Tests, die Swift-Seite null.

---

## Offen

- **Chip-Reihe oder cwd als Token in der Prompt-Zeile?** Die Reihe funktioniert
  und das ⌥-Cycling ist gut. Ein klickbares Token mit Popover wäre direkter und
  spart eine Reihe. Nicht entschieden, betrifft nur Phase 5.
- **Ambient**: Menüleisten-Symbol und Benachrichtigung bei fertigem
  Hintergrund-Run. Sinnvoll, sobald Runs Objekte sind — aber eine eigene
  Entscheidung, kein Automatismus.
- **Wieviel Sektion braucht die Liste?** Drei Quellen in einer Liste können auch
  in einem Ranking verschmelzen. Sektionen sind der sichere Start; Verschmelzen
  wäre eleganter, wenn sich die Scores überhaupt vergleichen lassen.
