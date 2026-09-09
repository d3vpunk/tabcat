# Plan: Globale Magic Names — ein Handle, das überall gilt

> **Status: Entwurf, nicht umgesetzt.** Am 2026-09-09 gegen den Code geprüft:
> `names.ts:63` (`cwdMatches`) behandelt `cwds.length === 0` bereits als
> „gilt überall" und wird von allen fünf Abfragen benutzt — der globale Fall
> existiert im Resolver, nur nicht im Anlegeweg. Hart auf `[cwd]` verdrahtet
> ist er an genau zwei Stellen: `run.ts:346` (REPL) und
> `engine-host.ts:222` (Daemon, bedient Plugin **und** GUI). Das Prädikat
> selbst ist außerhalb von `names.ts` zweimal von Hand nachgebaut
> (`run.ts:71`, `engine-host.ts:209`). Die GUI ruft nur `names resolve` und
> `names list` (`PromptModel.swift:1025`, `:1051`) — sie kann keine Handles
> anlegen und braucht deshalb keine Swift-Änderung.

## Ziel

Ein Handle darf **überall** gelten, nicht nur im Verzeichnis seiner Entstehung.
Der Regelfall bleibt verzeichnisgebunden — er ist in den meisten Fällen der
richtige, weil relative Pfade sonst am falschen Ort expandieren. Aber ein
Kommando ohne Ortsbezug soll nicht künstlich an einen Ort gefesselt sein:

```text
haiku → claude --dangerously-skip-permissions --effort low --model haiku
```

Das gilt in jedem Verzeichnis oder in keinem — ein `cwds`-Eintrag ist dafür
eine Lüge.

## Was schon da ist

Das Feature ist klein, weil `MagicName.cwds` von Anfang an mit dem leeren
Array als „kontextfrei" spezifiziert war (`MAGIC-NAMES-SPEC.md` §2:
„Empty array = context-free (surfaces everywhere) — not used by the manual
create flow, but the resolver must honor it"). Der Resolver honoriert es
konsistent in `handleFor`, `handleForPrefix`, `handles`, `resolve` und
`match`. `isMagicName` (`names-store.ts:28`) akzeptiert das leere Array
ebenfalls. Es fehlt nur der Weg, es zu **erzeugen**.

## Leitidee: eine Frage, ein Ort

Die Engine stellt zu Scopes exakt **eine** Frage — „gilt dieses Handle hier,
und wie spezifisch?" — und die wird an genau einer Stelle beantwortet. Kein
zweites Feld im Record, das synchron gehalten werden müsste, keine
Fallunterscheidung in den Abfragen, kein `switch` in den Oberflächen.

Verworfen wurden dafür zwei Alternativen:

- **Explizites `scope`-Feld im Record.** Selbstdokumentierend, aber zwei
  Quellen der Wahrheit: was gilt bei `scope: 'global'` *und* `cwds: ['/a']`?
  Jede Abfrage müsste sich entscheiden. Dazu Migration für Records ohne Feld.
- **Diskriminierte Union** (`{kind:'global'} | {kind:'dirs', cwds}`). In
  TypeScript am typsichersten, bricht aber das JSONL-Format und macht jeden
  Zugriff zum `switch` — für eine Engine, die nur eine Frage stellt, zu teuer.

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Repräsentation | `cwds: []` bleibt die Wahrheit. `scope` ist eine **abgeleitete Sicht**, kein gespeichertes Feld. Kein Formatwechsel, keine Migration, alte `names.jsonl` laufen weiter |
| Spezifität | Kein Boolean, sondern ein **Rang** (`specificityOf`). Heute zwei Stufen; die Repo-Subtree-Stufe aus `PLAN-cwd-cold-start.md` P2 wird ein Zwischenwert statt eines Umbaus |
| Präzedenz | **Lokal schlägt global**, wie `git config` oder `PATH`. Spezifität vor Zeitstempel — ein Comparator, den alle Abfragen teilen |
| Kollision | Gilt **nur innerhalb derselben Ebene**. Ein lokales Handle darf ein globales beschatten; ein globales darf entstehen, obwohl irgendwo ein gleichnamiges lokales liegt |
| Scope-Wahl (REPL) | `^G` togglet im offenen `Ctrl+N`-Badge. Sichtbar in der Badge-Zeile, damit die Funktion sich selbst erklärt |
| Speichern ohne Ausführen | `^S` im Badge. Nötig, weil das Umschalten eines bestehenden Handles sonst das Kommando startet |
| Scope-Wahl (Plugin) | Eigener Chord `^Xg`, konfigurierbar wie die anderen vier |
| Protokoll | Additiver `sub`-Wert `create-global`. **Kein** achtes Feld: die Arity-Prüfung ist strikt und die Swift-GUI sendet 7 Felder |
| Anzeige | Scope-Marker im REPL-Badge und in den Listen. **Nicht** im Discovery-Badge von Plugin und GUI |
| Tombstones | Bekommen eine eigene Funktion, damit `cwds: []` im Code ausschließlich „global" heißt |

## Datenmodell

`MagicName` bleibt unverändert. `names.ts` bekommt die Ableitungen, und
`cwdMatches` wird von einem privaten Prädikat zur exportierten, einzigen
Antwort:

```ts
export type NameScope = 'here' | 'global';

/** Rangabstand zwischen der exakten Stufe und global. Endlich, nicht
 *  Infinity: der Comparator subtrahiert zwei Ränge, und
 *  Infinity - Infinity ist NaN. Der Abstand lässt Platz für Zwischenstufen. */
export const GLOBAL_SPECIFICITY = 1_000;

export const isGlobal = (name: MagicName): boolean => name.cwds.length === 0;
export const scopeOf = (name: MagicName): NameScope => (isGlobal(name) ? 'global' : 'here');
export const cwdsFor = (scope: NameScope, cwd: string): string[] => (scope === 'global' ? [] : [cwd]);

/**
 * Wie spezifisch gilt das Handle in `cwd`? Kleiner = spezifischer,
 * `null` = gilt hier nicht. Die einzige Stelle im Projekt, die `cwds`
 * interpretiert — eine Subtree-Stufe (P2) ist hier ein Zwischenwert.
 */
export function specificityOf(name: MagicName, cwd: string): number | null {
  if (name.cwds.includes(cwd)) return 0;
  if (isGlobal(name)) return GLOBAL_SPECIFICITY;
  return null;
}

/** Ersetzt die zwei handgebauten Kopien in run.ts:71 und engine-host.ts:209. */
export const activeIn = (name: MagicName, cwd: string): boolean =>
  specificityOf(name, cwd) !== null;
```

Beide Anlegepfade werden von `cwds: [cwd]` zu `cwds: cwdsFor(scope, cwd)` —
ein Ausdruck, keine Verzweigung.

### Tombstone: eigene Tür

`cwds: []` ist heute doppelt belegt — Löschmarker schreiben es als Füllwert
(`run.ts:289`, `run.ts:343`, `engine-host.ts:239`). Kein Bug, weil `readNames`
Tombstones vor jeder Abfrage entfernt, aber mit diesem Plan bedeutet dasselbe
Array plötzlich „global". Deshalb:

```ts
// names-store.ts
export const appendTombstone = (file: string, line: string, ts: number): boolean => …
```

Danach heißt `cwds: []` an jeder verbleibenden Stelle im Code eindeutig
„global". `specificityOf` und `scopeOf` werden nie auf einen Record mit
`name === ''` angewandt — eine Löschung gilt dem Kommando, nicht einer Ebene.

## Präzedenz

Ein Comparator, den `resolve`, `match` und `handleForPrefix` teilen:

```ts
const bySpecificity = (cwd: string) => (a: MagicName, b: MagicName): number =>
  (specificityOf(a, cwd) ?? 0) - (specificityOf(b, cwd) ?? 0) || b.ts - a.ts;
```

Nur auf bereits gefilterten Listen anwenden — `?? 0` ist die Absicherung
gegen einen Aufruf ohne vorheriges `activeIn`, kein erwarteter Fall.

```text
dep → docker compose exec php composer install   [nur /projects/a]
dep → npm ci --prefer-offline                    [global]

/projects/a   dep → docker compose exec php composer install
/projects/b   dep → npm ci --prefer-offline
~             dep → npm ci --prefer-offline
```

In `match()` kommt ein **Dedupe nach Handle-Namen** dazu (erster gewinnt,
also der spezifischste): sonst stünden `dep` lokal und `dep` global als zwei
gleichnamige Einträge mit verschiedenen Auflösungen in der Dropdown.

`MAGIC_SCORE - index` bleibt, wie es ist. Die Reihenfolge trägt die Präzedenz;
eine cwd-Distanz im Score ist erst nötig, wenn P2 Zwischenstufen einführt.

## Kollision gilt nur innerhalb derselben Ebene

`handles(cwd)` als Kollisionsguard wird ersetzt:

```ts
/**
 * Handles, die eine neue Definition auf DIESER Ebene blockieren.
 * 'here'   → nur die in genau diesem cwd definierten (ein globales darf man
 *            legitim beschatten — lokal gewinnt hier ohnehin)
 * 'global' → nur die globalen (ein lokales irgendwo ist kein Konflikt)
 */
blockingHandles(scope: NameScope, cwd: string): string[]
```

Beide Anlegepfade rufen dasselbe auf. `handles(cwd?)` bleibt für Listings.

Damit geht der Fall durch, der das Feature ausgelöst hat: `haiku` global
anlegen, obwohl irgendwo ein lokales `haiku` liegt — ohne dort etwas zu
beschädigen.

## Der Regelfall bleibt: ein Kommando, ein Handle

Der Store ist nach Kommandozeile indiziert (`readNames`: last-wins pro
`line`), also hat jedes Kommando genau ein Handle. Ein bestehendes Handle
global zu machen ist deshalb **kein Anlegen, sondern ein Scope-Wechsel
desselben Records** — `Ctrl+N` prefillt, `^G` togglet, fertig. Ein Konflikt
kann nur zwischen zwei verschiedenen Kommandos mit gleichem Handle entstehen.

## Oberfläche: REPL

`naming` trägt den Scope mit, statt ihn in ein zweites Feld zu legen:

```ts
naming: { handle: string; scope: NameScope } | null;   // war: string | null
```

- `^G` togglet `scope`. `^U` leert nur `handle`. Der Zeichenfilter (`a-z0-9`,
  16 Zeichen) bleibt unverändert.
- `Ctrl+N` prefillt Handle **und** Scope aus dem bestehenden Record. Dafür
  bekommt `NameIndex` ein `nameFor(line, cwd): MagicName | null`, und
  `handleFor` wird dessen Einzeiler (`nameFor(…)?.name ?? null`) — keine
  zweite Wahrheit.
- Commit: `saveName?: { handle: string; scope: NameScope }`. `handle === ''`
  heißt weiter „löschen"; der Scope ist dort bedeutungslos.

```text
~/proj ❯ claude --dangerously-skip-permissions --effort low --model haiku
 ⚡ haiku▏  hier · ^G: global · ^S: save · enter: save+run · esc

~/proj ❯ claude --dangerously-skip-permissions --effort low --model haiku
 🌐 haiku▏  GLOBAL · ^G: nur hier · ^S: save · enter: save+run · esc
```

### `^S` — speichern ohne ausführen

Nötig, weil ein Scope-Wechsel sonst das Kommando startet: der Weg dorthin ist
`haiku` tippen → Tab expandiert → `Ctrl+N`. Bei `claude` wäre ein Start
harmlos, bei anderen Kommandos nicht.

`^S` ist das Spiegelbild des bestehenden `{ kind: 'forget', line, state }`
(`prompt-state.ts:139`) — eine Aktion, die persistiert, ohne auszuführen, und
den Prompt offen lässt. Also ein eigenes Outcome, kein Flag an `submit`:

```ts
| { kind: 'name'; line: string; saveName: { handle: string; scope: NameScope }; state: PromptState }
```

`run.ts` persistiert, zeigt den Toast (`🌐 haiku gilt jetzt überall`), Zeile
bleibt stehen — dieselbe Mechanik, die `^X` schon nutzt. Ein ungültiges
Handle bei `^S` speichert nicht und meldet es; anders als bei Enter gibt es
hier kein Ausführen, hinter dem der Fehlschlag verschwinden könnte.

`^S` auf **leerem** Badge ist „Namen löschen, ohne auszuführen" — also genau
das, was `^X` schon tut. Es liefert deshalb das bestehende
`{ kind: 'forget', line, state }` statt eines zweiten Löschwegs. Damit gilt in
beiden Commit-Wegen dieselbe Regel: leeres Badge = Name weg.

`^G` rechnet die Kollisionsanzeige neu, weil `blockingHandles` scope-abhängig
ist: ein Handle kann auf einer Ebene belegt und auf der anderen frei sein. Ein
`^G` kann ein rotes „belegt" also auflösen — das ist erwünscht und macht die
Ebenen-Regel im UI sichtbar, statt sie zu erklären.

Falls `^S` in einem Terminal von Flow Control abgefangen wird, ist `^O` der
Ausweichkandidat. Ink setzt Raw Mode, IXON ist damit normalerweise aus — beim
Umsetzen einmal unter tmux prüfen (vgl. `verify-shell-semantics`: messen,
nicht erinnern).

## Oberfläche: zsh-Plugin

`^Xg` als eigenes Widget `tabcat-label-global`, konfigurierbar über
`TABCAT_KEY_LABEL_GLOBAL` wie die vier bestehenden Chords
(`tabcat.plugin.zsh:42`).

`tabcat-label` und `tabcat-label-global` sind **ein gemeinsamer Rumpf** mit
einem Scope-Argument, kein zweites Widget mit kopiertem Körper. Der
Minibuffer-Prompt sagt `tabcat handle, global (3-16, a-z0-9):`, der Toast
`⚡ hier` bzw. `🌐 überall`.

Ein Toggle im Minibuffer ist nicht möglich — `read-from-minibuffer` liest eine
Zeile und gibt keine Sondertasten heraus. Deshalb zwei Chords statt einem
Modus.

## Oberfläche: GUI

Keine Änderung. Die GUI liest nur (`names resolve`, `names list`) und
profitiert automatisch, weil `activeIn` global gewordene Handles überall
ausliefert.

## Protokoll

`sub` bekommt den additiven Wert `create-global`:

```ts
if (sub !== 'list' && sub !== 'create' && sub !== 'create-global' && …)
```

Beide Werte mappen im `engine-host` auf **einen** Handler mit
Scope-Parameter, nicht auf zwei Pfade.

Ein achtes Feld ist hier keine harmlose Erweiterung: `parseRequest` prüft
`fields.length !== FIELD_COUNT[op]` strikt (`protocol.ts:153`), und die
Swift-GUI sendet für `names` 7 Felder (`Wire.swift:53` setzt
`op, id, protocolVersion` vor die vier Nutzfelder). Eine Arity-Änderung würde
sie mit `bad_fields` abwerfen, obwohl sie mit Scopes nichts zu tun hat — plus
`PROTOCOL_VERSION`-Bump und koordinierten Rebuild. Ein neuer `sub`-Wert kostet
nichts davon; `PLAN-cwd-cold-start.md` P3 nennt dieselbe Regel für die
`cwds`-Op.

Ein alter Daemon antwortet `bad_value: unknown names op: create-global`. Das
Plugin zeigt diesen Grund bereits an (`tabcat.plugin.zsh:751`), und seit
`0a62077` tritt ein veralteter Daemon von selbst ab.

## Anzeige — bewusst asymmetrisch

- **REPL-Badge:** `⚡`/`🌐` plus Scope-Wort in der Hint-Zeile.
- **`:names` und `tabcat names`:** eine Scope-Spalte (`🌐 überall` bzw. der
  Pfad). Das ist die Stelle, an der ein Nutzer seine Handles überblickt.
- **Discovery-Badge in Plugin und GUI:** bleibt `⚡handle`, **ohne** Marker.
  Dort ist die einzige relevante Aussage „gilt hier", und die stimmt in beiden
  Fällen. Das erspart ein Protokollfeld und jede Swift-Änderung.

## Aufräumarbeit (Teil dieser Änderung, nicht separat)

1. `cwdMatches` → exportiertes `activeIn`; die Kopien in `run.ts:71` und
   `engine-host.ts:209` verschwinden.
2. `appendTombstone` in `names-store.ts`; die drei handgeschriebenen
   Tombstone-Literale verschwinden.
3. Nach 1. und 2. gibt es **null** Zugriffe auf `.cwds` außerhalb von
   `src/engine/names*.ts`.

## Tests (TDD)

- **`names.test.ts`** trägt die Last: `specificityOf` (alle drei Rückgaben),
  `activeIn`, `scopeOf`, `cwdsFor`, `bySpecificity`, Dedupe in `match`,
  `blockingHandles` auf beiden Ebenen, und der Konfliktfall `dep` lokal +
  `dep` global über drei Verzeichnisse.
- **`names-store.test.ts`**: `appendTombstone`; `isMagicName` mit `cwds: []`;
  ein globaler Record übersteht Schreiben und Lesen.
- **`prompt-state.test.ts`**: `^G` togglet, `^S` liefert `kind: 'name'` und
  **kein** `submit`, `Ctrl+N` prefillt Scope, Kollisionsanzeige pro Ebene,
  `^G` ist außerhalb des Badges unverändert wirkungslos.
- **`app.test.ts`**: Badge rendert `⚡`/`🌐` und die richtige Hint-Zeile.
- **`engine-host.test.ts`**: `namesCreate` mit beiden Scopes;
  `blockingHandles`-Semantik am Daemon.
- **`protocol.test.ts`**: `create-global` wird geparst, Arity bleibt 7, eine
  unbekannte `sub` bleibt `bad_value`.
- **`plugin/zpty.test.ts`**: `^Xg` legt global an, `^Xl` unverändert lokal.
- **Guard-Test**: greppt den Quellbaum und schlägt fehl, wenn `.cwds`
  außerhalb von `src/engine/names*.ts` auftaucht. Die mechanische Fassung der
  Anforderung „stabile Grundlage" — ohne ihn erodiert die Kapselung beim
  nächsten Feature genau so, wie sie es schon zweimal getan hat.

## Bezug zu PLAN-cwd-cold-start.md

P2 fragt dort: „Gilt die Staffelung auch für `names.ts`? Dort ist es kein
Score, sondern ein Sichtbarkeits-Filter (boolean). Vermutlich richtig: Handle
sichtbar im ganzen Repo, aber in der Rangfolge hinter einem exakt passenden."

Dieser Plan beantwortet die halbe Frage und verbaut die andere Hälfte nicht:
`specificityOf` ist der Rang, den P2 braucht. Eine Repo-Subtree-Stufe wird
dort ein Zwischenwert zwischen `0` und `GLOBAL_SPECIFICITY` — `activeIn`,
`bySpecificity` und alle Abfragen bleiben unverändert. Was P2 zusätzlich
verlangt (cwd-Distanz im Score von `match`), bleibt offen und ist hier nicht
nötig, weil zwei Stufen von der Sortierreihenfolge getragen werden.

## Bewusst nicht im Scope

- **Ein Kommando mit mehreren Handles** (verschiedene je Verzeichnis). Der
  Store ist nach `line` indiziert; das zu ändern wäre ein anderer Plan.
- **`cwds` mit mehreren Verzeichnissen** aus der Oberfläche heraus füllen. Das
  Modell trägt es, `activeIn` behandelt es korrekt, aber es gibt keine
  Interaktion dafür — und ohne P2 wäre sie auch nicht die richtige Antwort auf
  „gilt im ganzen Repo".
- **Interaktives `:names`** (navigieren, Scope in der Liste umschalten). Wäre
  der natürliche Ort fürs Aufräumen, ist aber mehr Arbeit als dieses Feature
  und braucht `^S` nicht.
- **Negativ-Scope** („überall außer hier"). Das Einzige, was die Repräsentation
  wirklich sprengen würde — und kein bekanntes Bedürfnis.
- **Automatik**: keine Heuristik, die ein Kommando ohne relative Pfade von
  selbst global macht. `MAGIC-NAMES-SPEC.md` §1: der Nutzer entscheidet.

## Schritte

1. **Engine.** `NameScope`, `isGlobal`, `scopeOf`, `cwdsFor`,
   `specificityOf`, `activeIn`, `bySpecificity`, `nameFor`,
   `blockingHandles`, Dedupe in `match`. Tests zuerst.
2. **Store.** `appendTombstone`; die drei Literale ersetzen.
3. **Aufräumen.** `run.ts:71` und `engine-host.ts:209` auf `activeIn`;
   Guard-Test scharf machen.
4. **REPL-State.** `naming` als Objekt, `^G`, `^S` als `kind: 'name'`,
   Prefill mit Scope, `blockingHandles` im Badge-Guard.
5. **REPL-Render.** Badge-Marker und Hint-Zeile, Toast, `:names`-Spalte.
6. **CLI.** `tabcat names` mit Scope-Spalte.
7. **Daemon.** `namesCreate(scope, …)`, `sub: 'create-global'` im Protokoll.
8. **Plugin.** `^Xg`, gemeinsamer Rumpf, `TABCAT_KEY_LABEL_GLOBAL`.
9. **Doku.** README: Tastentabelle (`^G`, `^S`, `^Xg`), Magic-Names-Abschnitt
   (Scope, Präzedenz), Konfigurationstabelle.

Nach jedem Schritt läuft die Suite grün; Schritt 1–3 sind für sich schon eine
Verbesserung, auch ohne Oberfläche.
