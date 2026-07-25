# Plan: cwd-Awareness — Cold Start und Exact-Match

> **Status: offen.** Nichts davon ist umgesetzt. Die drei Kernbehauptungen sind
> am 2026-07-25 gegen den Code geprüft: `cli.ts:127` übergibt beim Import `null`
> als cwd, `model.ts:183` boostet nur bei `o.cwd === cwd` (exakte
> String-Gleichheit), `names.ts:63` matcht per `cwds.includes(cwd)` — Unterordner
> erben also von nichts. `simulate` rankt weiterhin genau eine Zeile. Gesammelt am 2026-07-25 aus der
> Diskussion über ein drittes Interface (macOS-GUI), aber die Probleme sind
> **allgemein** — sie betreffen zsh-Plugin und REPL genauso. Die GUI hat sie nur
> sichtbar gemacht, weil sie das cwd explizit auswählen muss statt es von der
> Shell geschenkt zu bekommen.

## Kontext

`ScoringConfig.cwdBoost` ist der einzige Mechanismus, mit dem tabcat
projektspezifische Vorhersagen macht. Wenn er nicht greift, ist das Ranking rein
global: `npm test` aus Projekt B konkurriert gleichberechtigt mit `npm test` in
Projekt A. Vier Probleme stehen im Weg.

---

## Was NICHT das Problem ist

Damit das nicht nochmal von vorne diskutiert wird: **der zsh/bash-Import
vergiftet das Ranking nicht.**

- `cli.ts:127` übergibt `null` als cwd — kein falsches Verzeichnis wird erfunden.
  `model.ts:10` dokumentiert das als Absicht.
- `model.ts:183` behandelt `cwd === null` als Boost 1, nicht als Malus. Degradiert
  sauber.
- Die Decay-Mathematik erledigt den Rest. Mit `halfLifeDays: 7`,
  `shortWeight: 8`, `shortHalfLifeHours: 4`, `cwdBoost: 3`:
  - 30 Tage alte importierte Occurrence: `max(0.5^(30/7), 0.02) ≈ 0.05`, kein
    Short-Term-Anteil, Boost 1 → **≈ 0.05**
  - frische Occurrence im passenden cwd: `(≈1 + ≈8) × 3` → **≈ 27**
  - Ein echter lokaler Treffer schlägt also ~500 importierte.
- `maxOccurrencesPerEdge: 64` wirft die alten Occurrences pro Edge zusätzlich
  raus, sobald echte nachkommen. Der Import läuft von selbst aus.

Der Import ist also kein Qualitätsproblem, sondern nur **keine Hilfe** für
cwd-Awareness. Das ist P1.

---

## P1 — cwdBoost hat keinen Cold Start (temporär, heilt durch Nutzung)

Importierte History trägt kein cwd (zsh `EXTENDED_HISTORY` speichert keins,
bash auch nicht, fish auch nicht). Nach dem Import stehen also tausende
Occurrences mit `cwd: null` im Store, und `cwdBoost: 3` ist toter Ballast, bis
der User in **jedem** Verzeichnis einmal selbst getippt hat.

Effekt: In den ersten Tagen nach Installation verhält sich tabcat wie ein
globaler Frecency-Ranker. Genau in der Phase, in der der User entscheidet, ob
das Tool etwas kann.

**Mögliche Seed-Quellen** (keine ist evaluiert):

| Quelle | Liefert | Problem |
|---|---|---|
| `~/.local/share/atuin/history.db` | Kommando **+** cwd, echte Paare | nur wenn User Atuin hat |
| `~/.local/share/zoxide/db.zo` | cwd-Menge + Frecency, **keine** Paare | hilft nur P3, nicht P1 |
| `mdfind "kMDItemFSName == '.git'"` | cwd-Menge, keine Paare | nur macOS, hilft nur P3 |
| `fish_history` | keine cwds | fällt weg |

Nur Atuin löst P1 wirklich, weil nur dort die Zuordnung Kommando↔Verzeichnis
existiert. Alles andere löst P3.

**Offene Fragen:**
- Atuin-Import bauen? Format ist SQLite, Schema versioniert sich eigenständig.
- Was passiert bei Konflikten, wenn User Atuin **und** tabcat parallel nutzt —
  doppelte Occurrences für dieselben Kommandos?
- Lohnt ein Import überhaupt, wenn P2 gefixt ist? Ein gefixtes P2 macht das
  erste echte Kommando pro Repo warm, dann ist der Cold Start nur noch Stunden
  lang statt Wochen.

---

## P2 — cwd-Vergleich ist Stringgleichheit (permanent, größter Hebel)

Drei Stellen, gleiche Bug-Klasse:

```ts
// src/engine/model.ts:183
const boost = o.cwd !== null && o.cwd === cwd ? this.config.cwdBoost : 1;

// src/engine/names.ts:62
const cwdMatches = (name: MagicName, cwd: string): boolean =>
  name.cwds.length === 0 || name.cwds.includes(cwd);
```

`~/projects/tabby/src` erbt **nichts** von `~/projects/tabby`. Jedes
Unterverzeichnis eines Repos startet wieder kalt. Bei `names.ts` heißt das: ein
Handle, das in der Repo-Wurzel angelegt wurde, ist zwei Ebenen tiefer
unsichtbar — der User sieht das als „mein Handle ist weg".

Das heilt **nie**. In `src/engine/` ist man selten genug, dass es auch nach
Monaten kalt bleibt.

**Lösungsskizze — gestufter Boost statt binär:**

```
exakt gleiches Verzeichnis      → 3.0   (heute: 3)
gleiches Repo (git-root Match)  → 1.8
Vorfahre/Nachfahre, kein Repo   → 1.4
sonst                           → 1.0
```

Braucht ein zusätzliches Feld auf `Occurrence`/`HistoryEntry`, z. B.
`root: string | null`, einmal beim `learn` bestimmt.

**Migration ist gratis:** `isHistoryEntry` (`store.ts:161`) prüft strukturell und
duldet Extrafelder. Neue Zeilen mit `root` lesen alte Daemons ohne Fehler, alte
Zeilen ohne `root` liefern `undefined`. Kein Schema-Bump, kein Rewrite von
`history.jsonl`.

**Offene Fragen:**
- **Kosten im Hot Path.** git-root-Bestimmung ist ein Verzeichnis-Walk bis
  `.git` gefunden ist. Beim `learn` einmal pro Kommando ist das vertretbar,
  beim `predict` pro Keystroke **nicht**. Also: Cache `cwd -> root`, im Daemon
  gehalten, invalidiert wann? Ein `git init` oder ein Umzug ändert das Ergebnis.
  TTL? Oder nur beim `learn` auflösen und beim `predict` das übergebene cwd
  einmal am Anfang der Session auflösen?
- **Worktrees und Submodule.** `.git` ist dort eine Datei, kein Verzeichnis. Und
  ein Submodul hat eine eigene Wurzel — soll es vom Parent-Repo erben oder nicht?
- **Verzeichnisse ohne Repo.** `~/Downloads`, `/etc`, `/tmp` — dort greift nur
  die Vorfahren-Stufe. Ist `1.4` für „irgendwo unter `$HOME`" sinnvoll, oder
  wird das zu einem Pseudo-Boost für alles? Vermutlich braucht die
  Vorfahren-Stufe eine Tiefenbegrenzung, sonst matcht `/` gegen alles.
- **Symlinks.** Wird `cwd` als `realpath` gespeichert? Wenn nicht, sind
  `/Users/x/proj` und `/Users/x/Code/proj` (Symlink) zwei kalte Zellen für
  dasselbe Repo. Muss geprüft werden, was zsh als `$PWD` liefert (logischer
  Pfad, also **nicht** realpath).
- **`$HOME`-Portabilität.** Absolute Pfade in `history.jsonl` überleben keinen
  Username-Wechsel und keine Sync zwischen Maschinen. Tilde-Normalisierung
  jetzt einführen oder bewusst ignorieren?
- **Gilt die Staffelung auch für `names.ts`?** Dort ist es kein Score, sondern
  ein Sichtbarkeits-Filter (boolean). Vermutlich richtig: Handle sichtbar im
  ganzen Repo, aber in der Rangfolge hinter einem exakt passenden. Das
  verlangt, dass `match()` die Distanz in den Score einrechnet
  (`MAGIC_SCORE - index` kennt heute keine cwd-Distanz).
- **Zahlen sind geraten.** `cwdBoost: 3` ist selbst nie gemessen worden. 1.8/1.4
  ist Gefühl. Siehe P4.

---

## P3 — Es gibt keine ableitbare cwd-Liste

`cli.ts:143` (im `stats`-Pfad) ist heute die einzige Stelle, die cwds
aggregiert:

```ts
if (entry.cwd !== null) byCwd.set(entry.cwd, (byCwd.get(entry.cwd) ?? 0) + 1);
```

Zählung, keine Rangfolge, kein Decay, und beim Cold Start leer (siehe P1). Wer
eine „meistgenutzte Verzeichnisse"-Liste braucht — die geplante GUI, aber auch
ein `tabcat stats --dirs` oder eine cwd-Suche im REPL — kann sie aus dem Store
nicht bekommen.

**Lösungsskizze:** Frecency über cwds mit derselben Formel wie
`occurrenceScore`, aber ohne Boost-Term. Als Daemon-Op `cwds` exponierbar
(additiv, kein `PROTOCOL_VERSION`-Bump — alte Clients senden die Op nie).

**Offene Fragen:**
- Verzeichnisse, die es nicht mehr gibt: filtern (kostet ein `stat` pro Eintrag)
  oder mit Flag zurückgeben und den Client entscheiden lassen?
- Aggregation auf Repo-Wurzel oder pro Verzeichnis? Für eine Auswahlliste ist
  Repo-Wurzel fast sicher richtig, für den Boost nicht. Zwei Sichten auf
  dieselben Daten.
- Cold-Start-Seed (Spotlight/zoxide) als eigene Quelle kennzeichnen, damit ein
  Client geratene von gelernten Einträgen unterscheiden kann?

---

## P4 — Keine Evaluationsharness (blockiert P1 und P2)

`tabcat simulate` ist ein **Einzelzeilen-Inspektor**, kein Replay:

```
simulate  Show ranking for a line: --line <str> [--cwd <dir>] [--now <ms>] [--json]
```

Es zeigt das Ranking für genau eine Eingabe. Es sagt nichts darüber, ob eine
Scoring-Änderung über einen Korpus hinweg besser oder schlechter ist. Jede
Änderung an `DEFAULT_SCORING` ist damit heute Raten mit Anekdoten-Bestätigung.

**Was fehlt:** Ein Replay-Harness, das über `history.jsonl` läuft, für jeden
Eintrag an jeder Präfix-Länge `predict` fragt und eine Kennzahl ausgibt —
gesparte Keystrokes, Top-1-Trefferquote, Mean Reciprocal Rank. Dann ist
„1.8 statt 3.0" eine Messung.

**Und der Haken, der P4 hart macht:** Ein Korpus, mit dem man **cwd**-Scoring
messen kann, muss cwds enthalten. Importierte History hat `null` (P1). Also
taugt nur selbst aufgezeichnete tabcat-History als Testkorpus — und die
existiert erst nach Wochen Nutzung, pro Maschine, und ist nicht teilbar
(Pfade sind privat, `history.jsonl` ist bewusst `0600`).

**Offene Fragen:**
- Synthetischen Korpus generieren (N Projekte, M Kommandos, realistische
  Wiederholungsmuster)? Risiko: man messt dann die Annahmen des Generators.
- Anonymisierten Export bauen (Pfade auf `repo1/sub2` mappen, Kommandos auf
  Token-Hashes), damit Korpora zwischen Maschinen wanderbar sind?
- Train/Test-Split über die Zeitachse — Modell auf den ersten 80 % lernen, auf
  den letzten 20 % messen. Sonst messt man Auswendiglernen.

---

## Reihenfolge

1. **P4 zuerst.** Ohne Messung ist P2 eine Änderung an geratenen Zahlen gegen
   andere geratene Zahlen. Die Harness ist außerdem für sich nützlich
   (Regressionsschutz für jede Engine-Änderung).
2. **P2.** Größter Hebel, heilt nie von selbst, betrifft Plugin und REPL sofort.
   Ein gefixtes P2 schrumpft P1 von Wochen auf Stunden.
3. **P3.** Kleine additive Op, braucht P2 nicht, wird aber besser damit
   (Repo-Aggregation).
4. **P1** zuletzt und nur, wenn P2 nicht genug war. Ein Atuin-Import ist Arbeit
   für eine Minderheit der User; die Mehrheit hat nur zsh-History ohne cwd.
