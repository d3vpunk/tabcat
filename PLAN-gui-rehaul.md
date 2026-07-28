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

**Erledigt am 2026-07-27: `search` und `cwds` in derselben Liste, sektioniert.** Damit
fallen ^R und der History-Modus weg — nicht ersetzt, ersatzlos.

Drei Quellen, eine flache Indexliste. Der Header ist eine Eigenschaft der **ersten
Zeile** eines Abschnitts und keine eigene Zeile: eine Header-Zeile wäre etwas, auf dem
↑/↓ landen und Enter zugreifen kann. Reihenfolge Completions, History, Directories, und
die ist nicht kosmetisch — Zeile 0 ist, was der Ghost zeigt und Tab nimmt, also muss der
Abschnitt oben stehen, den der Prompt gerade vervollständigt.

- **History** füllt genau das Loch, das messbar war: `predict "test"` gibt auf dieser
  Maschine **einen** Kandidaten (`tests/`, fs), weil Predictions einen *Präfix* matchen.
  `npm test` ist für sie unerreichbar. `search` matcht überall in der Zeile, mit
  derselben `fuzzySearch` wie ^R. Zehn Treffer, die Zahl die ^R zeigt: `search` wertet
  Substring über Subsequence, und der Subsequence-Schwanz ist so lang wie die History —
  `tst` ist Subsequence fast jeder Zeile. Das Ranking ist der Filter, zehn ist wo es noch
  einer ist. Annehmen ersetzt die **ganze** Zeile, weil das ist was gematcht hat; deshalb
  ist eine History-Zeile kein `Candidate` mit grossem `replace` — das rechnet vom Caret
  zurück und liesse stehen, was dahinter steht.
- **Directories** macht die Rangliste jenseits der fünf Chips überhaupt erreichbar.
  `cwds` wird jetzt mit 50 geholt statt mit 5; die Chip-Reihe ist ein Anzeige-Deckel
  geworden, kein Hol-Deckel. Gefiltert wird lokal, also kostet der Abschnitt keinen
  Roundtrip. Substring und bewusst nicht die Subsequence der History: `tst` ist
  Subsequence fast jedes Pfads, und eine Liste von fünfzehn Verzeichnissen auf vierzehn
  gefiltert hat nichts gefiltert. Gematcht wird der **letzte Token** (`cd fron` ist der
  Moment, in dem der Abschnitt am meisten gewollt ist und ein Ganzzeilen-Match nichts
  fände) gegen den Pfad **wie er dasteht**, `~` und alles, damit `~/pro` findet was das
  Auge liest.
- **Enter auf einer Verzeichniszeile bewegt sofort**, an jedem Index. Zweistufiges Enter
  existiert, damit nichts startet, bevor es sichtbar ist — hier startet nichts:
  Navigation macht keine Card, braucht keine Bestätigung und `cd -` holt sie zurück
  (Phase 0c). Darüber bewegt die Chip-Reihe auf einen Klick, eine Zeile die zwei
  bräuchte widerspräche der Reihe direkt über ihr. „An jedem Index" ist der Teil, der
  einen falschen Ausgang schliesst: Index 0 gehört der getippten Zeile, und bei einer
  Eingabe, die nur ein Verzeichnis traf, hätte Enter die Eingabe als Kommando ausgeführt.
  Tab geht stattdessen weiter — eine Tippen-Taste hat nichts einzusetzen.
- Der Ghost verstummt von selbst, ohne Sonderfall: `current` ist nur auf einer
  Completion-Zeile gesetzt. Ein Ghost verspricht „das wird angehängt", und beide anderen
  Arten brechen das Versprechen.

Zwei Roundtrips pro Tastendruck, `search` **nach** `predict`: am Ghost hängt die
Prediction, und ein Fuzzy-Match über die ganze History darf nicht das sein, was einen
Tastendruck verzögert. Nebenläufig zu fragen bringt nichts — der Socket trägt konstruktiv
eine Anfrage zur Zeit, es würde nur dieselbe Warteschlange umsortieren.

Zwei Tabellen, wie üblich nach Fehlerart getrennt. `suggestions: 15/15` über die reine
Funktion (Reihenfolge, Header genau auf der ersten Zeile, Dedupe, die zwei
Zeichen Untergrenze, cwd ausgeschlossen, Index == Position). Und ein **Live-Probe** für
`search`, weil eine Tabelle die Leitung nicht sieht: `names list` kam mal als
`bad_fields` zurück, und eine Methode, die jeden Fehler als „nichts gefunden" liest,
hätte einen leeren Abschnitt gemeldet statt einer kaputten Anfrage. Gemessen:
`search "install"` → `yarn install`, `npm install`.

Die Sechs-Zeilen-Höhe zählt die Header mit, statt sie zu verschlucken. Die Zahl ist das
Frame des ScrollViews, also hätte ein nur für Zeilen gerechneter Viewport fünf gezeigt
und die sechste beschnitten, sobald ein Abschnitt beginnt — und eine beschnittene Zeile
sieht aus wie eine Liste, die zu Ende ist. Eine Konstante für Arithmetik und für den
gezeichneten Header, damit das Frame keine Zeile verspricht, die die View nicht malt.

**Offen:** die Detailspalte rechts. Sie braucht Daten, die es auf der Leitung nicht gibt
— eine Kandidatenzeile ist `insert`, `display`, `source`, Handle und `replace`, und
`RankedCandidate` hat einen Score, aber keine Herkunft. Häufigkeit, letzte Nutzung und
Lernverzeichnis sind ein TypeScript-Schritt zuerst, in einer Antwortzeile, die Plugin und
REPL mitlesen.

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

### Phase 3 — Handles (Badge ✅, Rest offen)

**Erledigt am 2026-07-26: das minimierte Badge zeigt den Handle.** Ein Badge ist
300 pt breit, also endet alles über ~40 Zeichen im Ellipsis — und bei
`docker compose -f qlico/docker-compose.yaml run php vendor/bin/…` bleibt genau der
Teil stehen, den jeder dieser Runs gemeinsam hat. Der Handle ist der Name, den der
User dem Ding gegeben hat, weil er die kurze Art ist zu sagen welches es ist.

Zwei Wege zu einem Handle, beide beim Absenden bezahlt, keiner auf dem Tippweg: die
getippte Zeile **war** der Handle (die Expansion ist der Beweis), oder sie wurde
ausgeschrieben und der Daemon hat trotzdem einen Namen dafür — Rückwärtssuche über
`names list`. Gemessen gegen den laufenden Daemon: `"npm publish"` → `publish`.

Dabei gefangen, bevor es lief: `names` ist auf der Leitung ein festes Siebenfeld
(`protocol.ts`, FIELD_COUNT), ein `["list", cwd]` quittiert der Daemon mit
`bad_fields: names expects 7 fields, got 5` — und die Methode hätte das als „kein
Handle" verschluckt. Das Feature wäre still tot gewesen.

Die Card in front zeigt weiter das Kommando: dort ist Platz, und das Terminal
darunter zeigt die Ausgabe genau dieses Kommandos.

**Offen:** ⌘N als Popover, ⌘⌫ zum Vergessen, beides über `names create`/`delete`.
Magic-Kandidaten als echte Listenzeile mit ⚡ (steht, seit Phase 0d). Ein Badge
erfährt heute nichts davon, wenn der Handle erst nach dem Start angelegt wird — mit
⌘N wird das sichtbar und ist dann fällig.

### Phase 4 — Runs als Objekte

Ablage, Persistenz, Suche, Re-Run, Copy, „in Terminal öffnen", nachträgliches
Benennen. Keystrokes in die pty routen (termios regelt Echo, `sudo` verhält sich
wie im Terminal). Laufzeit auf der Card.

### Phase 5 — Launcher-Flow (Wegschicken ✅, Rest offen)

**Erledigt am 2026-07-26: eine Leiter fürs Wegschicken, drei Wege hinein.**

Escape nimmt eine Sprosse pro Druck, und die Reihenfolge ist die Vorgabe: erst das
zurückgehaltene Kommando, dann die Prompt-Zeile frei, dann die Card in front in die
Rail, und erst mit nichts mehr zum Aufräumen meint Escape das ganze Overlay. Die
dritte Sprosse ist neu und ist bewusst dasselbe wie ⌘↓ — minimieren ist nicht
schliessen, das Badge holt die Ausgabe zurück.

Ein Klick auf das Panel, wo nichts gezeichnet ist, ist dieselbe Absicht wie die
letzte Sprosse und ist derselbe Code. Das war vorher gar nichts: das Panel
verschluckt jeden Klick in seinem Frame, gezeichnet oder nicht (Spike 1), also
landeten diese Klicks nirgends.

Focus-Verlust ist der dritte Weg, aber **nicht** derselbe: Escape und der Klick sind
Entscheidungen, ein Focus-Verlust kann eine Benachrichtigung oder eine App sein, die
sich selbst nach vorn holt. Er gibt Tastatur und Launcher her, wirft aber keine
fertigen Badges weg. Damit gilt: solange das Overlay steht, hat es den Focus — denn
den Focus zu verlieren heisst, nicht mehr zu stehen. Gemessen statt angenommen, ein
`.nonactivatingPanel` verliert beim Aktivieren einer anderen App wirklich `key` und
bleibt dabei sichtbar.

Dazu die Regel, dass der Prompt die Tastatur behält: ein Klick auf eine Run-Card
machte SwiftTerms View zum First Responder, und der schickt Tastendrücke in die pty
— ein Feature aus Phase 4, das es noch nicht gibt und das heute nur heisst, dass das
Nächstgetippte in einem laufenden Kommando verschwindet. Der Klick wird zuerst
ausgeliefert, danach holt sich das Feld die Tastatur zurück.

**Offen:** Freier Pfad neben den Chips. `status` aufgeteilt: Fehler laut und
eigenständig, „ready" unsichtbar (`PromptModel.swift:116` überschreibt heute Fehler
damit). Kontextsensitive Tastenlegende. Verzeichnisauswahl übersteht das
Wiederöffnen.

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
- ~~**Wieviel Sektion braucht die Liste?**~~ Entschieden am 2026-07-27, und zwar
  gegen das Verschmelzen: die drei Scores sind keine vergleichbaren Einheiten. Die
  Frecency eines Kommandos, der Substring-über-Subsequence-Score eines Fuzzy-Treffers
  und die Frecency eines Verzeichnisses zusammenzuwerfen gäbe eine Reihenfolge, die
  niemand erklären kann — auch nicht der, der sie später reparieren muss. Zwei Header
  statt drei: die Completions tragen keinen, weil sie das sind, in das die Prompt-Zeile
  weiterläuft, und ein Label darüber den Normalfall benennen würde.
