# Globale Magic Names — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Magic-Name-Handle darf global gelten (`cwds: []`) statt nur im Verzeichnis seiner Entstehung — anlegbar über `^G` im REPL-Badge und `^XL` im zsh-Plugin, umschaltbar ohne das Kommando auszuführen (`^S`).

**Architecture:** Der Resolver kann den globalen Fall bereits (`cwds.length === 0`); es fehlt nur der Anlegeweg. `src/engine/names.ts` wird die **einzige** Stelle, die `cwds` interpretiert (`specificityOf`, `activeIn`) oder konstruiert (`makeName`, `appendTombstone`). Präzedenz ist ein Rang statt eines Booleans, damit die Repo-Subtree-Stufe aus `PLAN-cwd-cold-start.md` P2 später ein Zwischenwert bleibt. Kollisionen gelten nur innerhalb derselben Ebene.

**Tech Stack:** TypeScript 5 (ESM, `.js`-Endungen in Imports), vitest, Ink 5 + React 18 (REPL), zsh (Plugin), Unix-Socket-TSV-Protokoll (Daemon). Node ≥ 20.

**Spec:** `PLAN-global-names.md` (committed als `c4d17e6` auf Branch `feat/global-magic-names`)

## Global Constraints

- **Keine neuen Dependencies.** Nichts zu `package.json` hinzufügen.
- **Protokoll-Arity bleibt 7** für `names` (`FIELD_COUNT` in `src/daemon/protocol.ts:130`). Kein achtes Feld, kein `PROTOCOL_VERSION`-Bump.
- **Keine Swift-Änderung.** Die GUI ruft nur `names resolve` / `names list` und profitiert automatisch.
- **`HANDLE_PATTERN` bleibt** `/^[a-z][a-z0-9]{2,15}$/` — Handle-Form ändert sich nicht.
- **Kein AI, keine Heuristik.** Der Scope wird vom Nutzer gewählt, nie geraten (`MAGIC-NAMES-SPEC.md` §1).
- **Testnamen und Code-Kommentare auf Englisch** (Repo-Stil). Diese Plan-Prosa ist deutsch.
- **Imports mit `.js`-Endung** (`from '../../src/engine/names.js'`), auch in Tests.
- **Suite nach jedem Task grün:** `npm test` (= `vitest run`, **ohne** Typecheck). Getypt wird erst von `npm run build` (`tsc`) — deshalb kann eine Signaturänderung die Suite grün lassen und den Build brechen. Nach Task 6, 8 und 11 zusätzlich `npm run build` laufen lassen.
- **Importe mitziehen:** jede neue Referenz braucht ihren Import (`NameScope`, `NamingState`, `makeName`, `activeIn`, `scopeOf`, `appendTombstone`, `formatNamesList` je nach Datei). `npm run build` findet Vergessenes.
- **`cwds` wird nur in `src/engine/names.ts` und `src/engine/names-store.ts` gelesen oder konstruiert.** Task 5 macht das mechanisch prüfbar.

## File Structure

| Datei | Verantwortung | Änderung |
|---|---|---|
| `src/engine/names.ts` | Datenmodell, Scope-Ableitung, Präzedenz, Index-Abfragen. **Die einzige Stelle, die `cwds` versteht.** | Task 1–3 |
| `src/engine/names-store.ts` | JSONL-Persistenz | Task 4 |
| `src/repl/prompt-state.ts` | Tastenlogik, `naming`-State | Task 6–7 |
| `src/repl/app.tsx` | Badge-Rendering, Outcome-Verarbeitung, `:names`-Panel | Task 8–9 |
| `src/repl/run.ts` | Persistenz-Anbindung, `:names`-Daten | Task 5, 8–9 |
| `src/cli.ts` | `tabcat names` | Task 10 |
| `src/daemon/engine-host.ts` | Daemon-Namensoperationen | Task 5, 11 |
| `src/daemon/protocol.ts` | `sub`-Werte | Task 11 |
| `src/daemon/server.ts` | Dispatch | Task 11 |
| `src/plugin/tabcat.plugin.zsh` | `^Xl` / `^XL` | Task 12 |
| `README.md` | Tastentabellen, Magic-Names-Abschnitt | Task 13 |
| `tests/engine/names-encapsulation.test.ts` | **Neu** — Guard gegen `cwds`-Leaks | Task 5 |

---

### Task 1: Scope-Ableitungen und Spezifitäts-Rang

**Files:**
- Modify: `src/engine/names.ts` (nach `HANDLE_PATTERN`, vor `cwdMatches` bei `:63`)
- Test: `tests/engine/names.test.ts`

**Interfaces:**
- Consumes: `MagicName` (existiert, `names.ts:12`)
- Produces:
  - `type NameScope = 'here' | 'global'`
  - `const GLOBAL_SPECIFICITY = 1_000`
  - `isGlobal(name: MagicName): boolean`
  - `scopeOf(name: MagicName): NameScope`
  - `cwdsFor(scope: NameScope, cwd: string): string[]`
  - `makeName(handle: string, line: string, scope: NameScope, cwd: string, ts: number): MagicName`
  - `specificityOf(name: MagicName, cwd: string): number | null`
  - `activeIn(name: MagicName, cwd: string): boolean`

- [ ] **Step 1: Write the failing test**

An `tests/engine/names.test.ts` anhängen (der `name()`-Helper und `CWD`/`OTHER` existieren bereits am Dateikopf):

```ts
describe('names: scope derivation', () => {
  it('derives the scope from cwds', () => {
    expect(scopeOf(name({ cwds: [CWD] }))).toBe('here');
    expect(scopeOf(name({ cwds: [] }))).toBe('global');
    expect(isGlobal(name({ cwds: [] }))).toBe(true);
    expect(isGlobal(name({ cwds: [CWD] }))).toBe(false);
  });

  it('cwdsFor is the inverse of scopeOf', () => {
    expect(cwdsFor('here', CWD)).toEqual([CWD]);
    expect(cwdsFor('global', CWD)).toEqual([]);
    expect(scopeOf(name({ cwds: cwdsFor('global', CWD) }))).toBe('global');
  });

  it('makeName is the only factory a caller needs', () => {
    expect(makeName('haiku', 'claude --model haiku', 'global', CWD, 7)).toEqual({
      name: 'haiku',
      line: 'claude --model haiku',
      cwds: [],
      ts: 7,
    });
    expect(makeName('dep', 'npm ci', 'here', CWD, 7).cwds).toEqual([CWD]);
  });

  it('ranks specificity: exact cwd beats global, foreign dirs do not apply', () => {
    expect(specificityOf(name({ cwds: [CWD] }), CWD)).toBe(0);
    expect(specificityOf(name({ cwds: [] }), CWD)).toBe(GLOBAL_SPECIFICITY);
    expect(specificityOf(name({ cwds: [OTHER] }), CWD)).toBeNull();
  });

  it('activeIn is specificityOf without the rank', () => {
    expect(activeIn(name({ cwds: [CWD] }), CWD)).toBe(true);
    expect(activeIn(name({ cwds: [] }), CWD)).toBe(true);
    expect(activeIn(name({ cwds: [OTHER] }), CWD)).toBe(false);
  });

  it('a global rank leaves room for intermediate steps (repo subtree, P2)', () => {
    // Regression guard for the comparator in Task 2: a finite rank keeps
    // subtraction defined (Infinity - Infinity is NaN) and leaves gaps.
    expect(GLOBAL_SPECIFICITY).toBeGreaterThan(1);
    expect(Number.isFinite(GLOBAL_SPECIFICITY)).toBe(true);
  });
});
```

Den Import am Dateikopf erweitern:

```ts
import {
  GLOBAL_SPECIFICITY, MAGIC_SCORE, MagicName, NameIndex, activeIn, cwdsFor, firstWord,
  handleIssue, isGlobal, makeName, scopeOf, specificityOf, validateHandle,
} from '../../src/engine/names.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/names.test.ts -t "scope derivation"`
Expected: FAIL — `SyntaxError` bzw. „does not provide an export named 'scopeOf'".

- [ ] **Step 3: Write minimal implementation**

In `src/engine/names.ts` **ersetzen** (das war `cwdMatches` bei `:63`):

```ts
export type NameScope = 'here' | 'global';

/**
 * Rank distance between the exact step and global. Finite on purpose: the
 * comparator subtracts two ranks, and Infinity - Infinity is NaN. The gap
 * leaves room for intermediate steps (repo subtree — PLAN-cwd-cold-start P2).
 */
export const GLOBAL_SPECIFICITY = 1_000;

export const isGlobal = (name: MagicName): boolean => name.cwds.length === 0;

export const scopeOf = (name: MagicName): NameScope => (isGlobal(name) ? 'global' : 'here');

export const cwdsFor = (scope: NameScope, cwd: string): string[] => (scope === 'global' ? [] : [cwd]);

/**
 * The only factory for a MagicName. Callers pass a scope, never a cwds array —
 * that keeps `cwds` an implementation detail of this module.
 */
export const makeName = (
  handle: string,
  line: string,
  scope: NameScope,
  cwd: string,
  ts: number,
): MagicName => ({ name: handle, line, cwds: cwdsFor(scope, cwd), ts });

/**
 * How specifically does this handle apply in `cwd`? Smaller = more specific,
 * `null` = does not apply here. The single place in the project that
 * interprets `cwds`.
 */
export function specificityOf(name: MagicName, cwd: string): number | null {
  if (name.cwds.includes(cwd)) return 0;
  if (isGlobal(name)) return GLOBAL_SPECIFICITY;
  return null;
}

/** Replaces the hand-built copies in run.ts and engine-host.ts. */
export const activeIn = (name: MagicName, cwd: string): boolean => specificityOf(name, cwd) !== null;
```

Dann in derselben Datei alle fünf Vorkommen von `cwdMatches(name, cwd)` durch `activeIn(name, cwd)` ersetzen — in `handleFor`, `handleForPrefix`, `handles`, `resolve`, `match`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — alle bestehenden `names`-Tests bleiben grün, weil `activeIn` dasselbe Prädikat ist.

- [ ] **Step 5: Commit**

```bash
git add src/engine/names.ts tests/engine/names.test.ts
git commit -m "feat(names): scope becomes a rank, not a hidden array length"
```

---

### Task 2: Präzedenz — lokal schlägt global

**Files:**
- Modify: `src/engine/names.ts` (`handleForPrefix`, `resolve`, `match`; neu: `nameFor`)
- Test: `tests/engine/names.test.ts`

**Interfaces:**
- Consumes: `specificityOf`, `activeIn`, `isGlobal` (Task 1)
- Produces:
  - `nameFor(line: string, cwd: string): MagicName | null` (Methode auf `NameIndex`)
  - `handleFor` bleibt `string | null` und wird der Einzeiler darüber
  - `resolve`, `match`, `handleForPrefix` sortieren spezifisch zuerst
  - `match` liefert **pro Handle-Name maximal einen** Kandidaten

- [ ] **Step 1: Write the failing test**

```ts
describe('names: precedence (local beats global)', () => {
  const LOCAL = name({ name: 'dep', line: 'docker compose exec php composer install', cwds: [CWD], ts: 100 });
  const GLOBAL = name({ name: 'dep', line: 'npm ci --prefer-offline', cwds: [], ts: 200 });
  const index = () => new NameIndex([LOCAL, GLOBAL]);

  it('resolves to the local command in its directory, to the global one elsewhere', () => {
    expect(index().resolve('dep', CWD)).toBe(LOCAL.line);
    expect(index().resolve('dep', OTHER)).toBe(GLOBAL.line);
  });

  it('ignores the newer timestamp when the local one is more specific', () => {
    // GLOBAL.ts is higher — specificity has to win, or a later global handle
    // would silently shadow an older local one.
    expect(index().resolve('dep', CWD)).toBe(LOCAL.line);
  });

  it('offers each handle once, resolved by the most specific record', () => {
    const here = index().match('de', CWD);
    expect(here).toHaveLength(1);
    expect(here[0]?.display).toBe(LOCAL.line);
    expect(here[0]?.magicName).toBe('dep');

    const elsewhere = index().match('de', OTHER);
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0]?.display).toBe(GLOBAL.line);
  });

  it('still ranks a shorter handle before a longer one', () => {
    const withOther = new NameIndex([LOCAL, GLOBAL, name({ name: 'deploy', line: 'make deploy', cwds: [] })]);
    expect(withOther.match('de', CWD).map((c) => c.magicName)).toEqual(['dep', 'deploy']);
  });

  it('nameFor returns the record, handleFor stays its name', () => {
    expect(index().nameFor(LOCAL.line, CWD)).toEqual(LOCAL);
    expect(index().nameFor(LOCAL.line, OTHER)).toBeNull();
    expect(index().handleFor(GLOBAL.line, OTHER)).toBe('dep');
    expect(scopeOf(index().nameFor(GLOBAL.line, OTHER)!)).toBe('global');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/names.test.ts -t "precedence"`
Expected: FAIL — `resolve('dep', CWD)` liefert `'npm ci --prefer-offline'` (Zeitstempel gewinnt), `match` liefert zwei Einträge, `nameFor` existiert nicht.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/names.ts` nach `activeIn` einfügen:

```ts
/**
 * More specific first, then newest — the comparator resolve, match and
 * handleForPrefix share. Only for lists already filtered by activeIn; the
 * `?? 0` is a guard against misuse, not an expected case.
 */
const bySpecificity =
  (cwd: string) =>
  (a: MagicName, b: MagicName): number =>
    (specificityOf(a, cwd) ?? 0) - (specificityOf(b, cwd) ?? 0) || b.ts - a.ts;
```

`handleFor` und `nameFor` ersetzen die bisherige `handleFor`:

```ts
  /** The record for an EXACT line, if one exists and applies in `cwd`. */
  nameFor(line: string, cwd: string): MagicName | null {
    const name = this.byLine.get(line);
    return name !== undefined && activeIn(name, cwd) ? name : null;
  }

  /** Handle for an EXACT line — powers the discovery badge. */
  handleFor(line: string, cwd: string): string | null {
    return this.nameFor(line, cwd)?.name ?? null;
  }
```

In `handleForPrefix` die Sortierung ersetzen — Nähe zum Getippten bleibt das erste Kriterium, die Präzedenz wird der Tiebreaker:

```ts
      .sort((a, b) => a.line.length - b.line.length || bySpecificity(cwd)(a, b));
```

In `resolve` die Sortierung ersetzen:

```ts
      .sort(bySpecificity(cwd));
```

In `match` Sortierung und Dedupe:

```ts
  match(prefix: string, cwd: string): RankedCandidate[] {
    const wanted = prefix.toLowerCase();
    const seen = new Set<string>();
    return [...this.byLine.values()]
      .filter((name) => name.name.startsWith(wanted) && activeIn(name, cwd))
      .sort((a, b) => a.name.length - b.name.length || bySpecificity(cwd)(a, b))
      // One row per handle: a local and a global `dep` would otherwise appear
      // twice with different resolutions. Sorted first, so this keeps the
      // most specific record.
      .filter((name) => (seen.has(name.name) ? false : (seen.add(name.name), true)))
      .map((name, index) => ({
```

Der `map`-Rumpf bleibt unverändert.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Falls ein bestehender `match`-Test auf Doppel-Einträgen bestand, ist das der erwartete Fund — im Test die neue Semantik festschreiben (ein Eintrag pro Handle), nicht das Dedupe zurücknehmen.

- [ ] **Step 5: Commit**

```bash
git add src/engine/names.ts tests/engine/names.test.ts
git commit -m "feat(names): the nearer handle wins — local beats global"
```

---

### Task 3: Kollision nur innerhalb derselben Ebene

**Files:**
- Modify: `src/engine/names.ts` (`NameIndex`, neben `handles`)
- Test: `tests/engine/names.test.ts`

**Interfaces:**
- Consumes: `NameScope`, `isGlobal` (Task 1)
- Produces: `blockingHandles(scope: NameScope, cwd: string): string[]` auf `NameIndex`. `handles(cwd?)` bleibt unverändert für Listings.

- [ ] **Step 1: Write the failing test**

```ts
describe('names: collisions apply within one level', () => {
  const localDep = name({ name: 'dep', line: 'docker compose exec php composer install', cwds: [CWD] });
  const globalHaiku = name({ name: 'haiku', line: 'claude --model haiku', cwds: [] });
  const foreignDep = name({ name: 'dep', line: 'cargo build', cwds: [OTHER] });
  const index = new NameIndex([localDep, globalHaiku, foreignDep]);

  it('a new local handle is blocked only by handles of this very directory', () => {
    expect(index.blockingHandles('here', CWD)).toEqual(['dep']);
    // A global handle may legitimately be shadowed locally.
    expect(index.blockingHandles('here', CWD)).not.toContain('haiku');
  });

  it('a new global handle is blocked only by global handles', () => {
    expect(index.blockingHandles('global', CWD)).toEqual(['haiku']);
    // The whole point: `haiku` may go global even though a local `dep`
    // exists, and a local handle somewhere is never a global conflict.
    expect(index.blockingHandles('global', CWD)).not.toContain('dep');
  });

  it('handles() keeps listing everything that applies here', () => {
    expect(index.handles(CWD).sort()).toEqual(['dep', 'haiku']);
    expect(index.handles(OTHER).sort()).toEqual(['dep', 'haiku']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/names.test.ts -t "collisions apply"`
Expected: FAIL — `index.blockingHandles is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `NameIndex`, direkt nach `handles`:

```ts
  /**
   * Handles that block a new definition on THIS level.
   * 'here'   → only those defined in this very cwd (a global handle may be
   *            legitimately shadowed — local wins here anyway)
   * 'global' → only the global ones (a local handle somewhere is no conflict)
   */
  blockingHandles(scope: NameScope, cwd: string): string[] {
    return [...this.byLine.values()]
      .filter((name) => (scope === 'global' ? isGlobal(name) : name.cwds.includes(cwd)))
      .map((name) => name.name);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/names.ts tests/engine/names.test.ts
git commit -m "feat(names): a collision only counts on the level it happens"
```

---

### Task 4: Der Tombstone bekommt eine eigene Tür

**Files:**
- Modify: `src/engine/names-store.ts` (nach `appendName`)
- Modify: `src/repl/run.ts:289`, `src/repl/run.ts:343`
- Modify: `src/daemon/engine-host.ts:239`
- Test: `tests/engine/names-store.test.ts`

**Interfaces:**
- Consumes: `appendName` (existiert)
- Produces: `appendTombstone(file: string, line: string, ts: number): boolean`

- [ ] **Step 1: Write the failing test**

An `tests/engine/names-store.test.ts` anhängen (Datei nutzt `mkdtempSync`/`join` — dem bestehenden Muster der Datei folgen):

```ts
describe('names-store: appendTombstone', () => {
  it('drops the handle of a line and survives a round trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-tomb-'));
    const file = join(dir, 'names.jsonl');
    appendName(file, makeName('haiku', 'claude --model haiku', 'global', '/p', 1));
    expect(readNames(file).map((n) => n.name)).toEqual(['haiku']);

    expect(appendTombstone(file, 'claude --model haiku', 2)).toBe(true);
    expect(readNames(file)).toEqual([]);
  });

  it('keeps a global record readable — cwds: [] is a scope, not a marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-tomb-'));
    const file = join(dir, 'names.jsonl');
    appendName(file, makeName('haiku', 'claude --model haiku', 'global', '/p', 1));
    const [read] = readNames(file);
    expect(read?.cwds).toEqual([]);
    expect(scopeOf(read!)).toBe('global');
  });
});
```

Imports der Testdatei um `appendTombstone` sowie `makeName`/`scopeOf` aus `names.js` erweitern.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/names-store.test.ts -t "appendTombstone"`
Expected: FAIL — kein Export `appendTombstone`.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/names-store.ts` nach `appendName`:

```ts
/**
 * Deletion marker for a command line, append-only. Its own function so that
 * `cwds: []` means exactly one thing in the rest of the codebase: global.
 * A deletion applies to the command, not to a level — which is why the
 * tombstone carries no scope.
 */
export const appendTombstone = (file: string, line: string, ts: number): boolean =>
  appendName(file, { name: '', line, cwds: [], ts });
```

Die drei Aufrufstellen ersetzen:

`src/repl/run.ts:289` (in `onForget`):
```ts
              appendTombstone(namesFile, forgotten, Date.now());
```

`src/repl/run.ts:343` (leeres Badge):
```ts
          appendTombstone(namesFile, line, Date.now());
```

`src/daemon/engine-host.ts:239` (in `namesDelete`):
```ts
    if (!appendTombstone(this.namesFile, line, this.now())) return false;
```

Imports in beiden Dateien anpassen (`appendTombstone` dazu; `appendName` bleibt, wo noch benutzt).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/names-store.ts src/repl/run.ts src/daemon/engine-host.ts tests/engine/names-store.test.ts
git commit -m "refactor(names): the tombstone stops borrowing the global scope"
```

---

### Task 5: Die zwei Kopien entfernen und den Guard scharf machen

**Files:**
- Modify: `src/repl/run.ts:71`
- Modify: `src/daemon/engine-host.ts:209`
- Create: `tests/engine/names-encapsulation.test.ts`

**Interfaces:**
- Consumes: `activeIn` (Task 1)
- Produces: nichts für spätere Tasks — dieser Task schließt die Kapselung ab.

- [ ] **Step 1: Write the failing test**

`tests/engine/names-encapsulation.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every .ts/.tsx file under src/, recursively. */
function sources(dir = 'src'): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/**
 * `cwds` is an implementation detail of the names module: `specificityOf` /
 * `activeIn` answer "does this apply here?", `makeName` / `appendTombstone`
 * construct records. Two hand-built copies of the predicate had already
 * drifted into run.ts and engine-host.ts before this guard existed.
 *
 * Scoped to files that import MagicName — the daemon's unrelated `cwds` op
 * (working directories by frecency) shares the word but not the meaning.
 */
describe('names: cwds stays encapsulated', () => {
  const OWNERS = ['src/engine/names.ts', 'src/engine/names-store.ts'];

  it('no file outside the names module touches cwds', () => {
    const offenders = sources()
      .filter((file) => !OWNERS.includes(file))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        if (!/\bMagicName\b/.test(text)) return false;
        return /\bcwds\b/.test(text);
      });

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/names-encapsulation.test.ts`
Expected: FAIL — `offenders` enthält `src/repl/run.ts` und `src/daemon/engine-host.ts`.

- [ ] **Step 3: Write minimal implementation**

`src/repl/run.ts:71` — die handgebaute Kopie ersetzen:

```ts
      const isActive = (name: MagicName): boolean => activeIn(name, context.cwd);
```

`src/daemon/engine-host.ts:209` — in `namesList`:

```ts
      .filter((name) => activeIn(name, cwd))
```

In beiden Dateien `activeIn` importieren.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — der Guard ist grün, alles andere unverändert.

Bleibt der Guard rot, nennt er die Datei: dort wird `cwds` noch direkt angefasst, und die richtige Antwort ist `activeIn` / `makeName`, nicht eine Ausnahme in `OWNERS`.

- [ ] **Step 5: Commit**

```bash
git add src/repl/run.ts src/daemon/engine-host.ts tests/engine/names-encapsulation.test.ts
git commit -m "refactor(names): one answer to 'does this apply here', enforced by a test"
```

---

### Task 6: `naming` trägt den Scope, `^G` schaltet ihn um

**Files:**
- Modify: `src/repl/prompt-state.ts` (`PromptState.naming` bei `:41`, `initialPromptState` bei `:63`, `existingHandles` bei `:311`, `Ctrl+N` bei `:405`, naming-Zweig bei `:331`)
- Test: `tests/repl/prompt-state.test.ts`

**Interfaces:**
- Consumes: `NameScope`, `blockingHandles` (Task 1, 3), `nameFor` (Task 2)
- Produces:
  - `interface NamingState { handle: string; scope: NameScope }` (exportiert aus `prompt-state.ts`)
  - `PromptState.naming: NamingState | null`
  - `KeyOutcome` `submit` trägt `saveName?: NamingState`

**Hinweis:** Dieser Task migriert bestehende Tests. `typedState(line, naming)` in `tests/repl/prompt-state.test.ts:536` nimmt heute `string | null`, und rund ein Dutzend Assertions prüfen `state.naming` gegen einen String. Das ist erwartete Arbeit, kein Fehlschlag.

- [ ] **Step 1: Write the failing test**

In `tests/repl/prompt-state.test.ts`, `describe('Prompt state: magic names (Ctrl+N badge)')`: den Helper ersetzen und Tests ergänzen.

```ts
  const naming = (handle: string, scope: NameScope = 'here'): NamingState => ({ handle, scope });

  const typedState = (line: string, namingState: NamingState | null = null): PromptState => ({
    ...initialPromptState,
    line,
    cursor: line.length,
    naming: namingState,
  });
```

Bestehende Assertions in diesem `describe` mitziehen, z. B.
`expect(state.naming).toBe('')` → `expect(state.naming).toEqual(naming(''))`,
`expect(state.naming).toBe('phpstananalyze')` → `expect(state.naming).toEqual(naming('phpstananalyze'))`.

Neue Tests:

```ts
  it('Ctrl+G toggles the scope of the open badge and keeps the handle', () => {
    let state = typedState(LONG, naming('haiku'));
    state = press(state, key('g', { ctrl: true }), magicCtx(names()));
    expect(state.naming).toEqual(naming('haiku', 'global'));
    state = press(state, key('g', { ctrl: true }), magicCtx(names()));
    expect(state.naming).toEqual(naming('haiku', 'here'));
  });

  it('Ctrl+G outside the badge stays a no-op', () => {
    const state = press(typedState(LONG), key('g', { ctrl: true }), magicCtx(names()));
    expect(state.naming).toBeNull();
    expect(state.line).toBe(LONG);
  });

  it('Ctrl+N prefills handle AND scope of a global handle', () => {
    const index = names([{ name: 'haiku', line: LONG, cwds: [], ts: 1 }]);
    const state = press(typedState(LONG), key('n', { ctrl: true }), magicCtx(index));
    expect(state.naming).toEqual(naming('haiku', 'global'));
  });

  it('submitting carries the scope', () => {
    const outcome = handleKey(typedState(LONG, naming('haiku', 'global')), key('', { return: true }), magicCtx(names()));
    expect(outcome).toEqual({ kind: 'submit', line: LONG, saveName: naming('haiku', 'global') });
  });

  it('a handle taken on the other level does not block', () => {
    // `dep` exists locally; going global with it must be allowed.
    const index = names([{ name: 'dep', line: 'other command', cwds: [CWD], ts: 1 }]);
    const outcome = handleKey(typedState(LONG, naming('dep', 'global')), key('', { return: true }), magicCtx(index));
    expect(outcome).toEqual({ kind: 'submit', line: LONG, saveName: naming('dep', 'global') });
  });

  it('a handle taken on the same level still blocks the save', () => {
    const index = names([{ name: 'dep', line: 'other command', cwds: [CWD], ts: 1 }]);
    const outcome = handleKey(typedState(LONG, naming('dep', 'here')), key('', { return: true }), magicCtx(index));
    expect(outcome).toEqual({ kind: 'submit', line: LONG });
  });
```

**Wichtig:** `tests/repl/prompt-state.test.ts` hat nur `press` (`:30`), und das **wirft** bei jedem Outcome außer `update`. Für Outcome-Tests deshalb `handleKey` direkt aufrufen — der Import existiert am Dateikopf bereits.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repl/prompt-state.test.ts -t "magic names"`
Expected: FAIL — Typfehler (`naming` ist `string`) und `Ctrl+G` verändert nichts.

- [ ] **Step 3: Write minimal implementation**

In `src/repl/prompt-state.ts` den `naming`-Kommentar und das Feld ersetzen:

```ts
  /**
   * null = not naming; otherwise the handle-in-progress of the Ctrl+N badge
   * together with the scope it would be saved on ('' = badge open and empty).
   * The command line freezes while naming — only the handle is being edited.
   */
  naming: NamingState | null;
```

Darüber, bei den Typen der Datei:

```ts
/** Handle-in-progress plus the level it would be saved on (^G toggles). */
export interface NamingState {
  handle: string;
  scope: NameScope;
}
```

`KeyOutcome`-Kommentar und Signatur (`:128`–`:133`):

```ts
  /**
   * saveName is only present when the submit came out of the naming badge:
   * a valid handle = create/overwrite on its scope, an empty handle = badge
   * left empty (delete the handle if the command had one). Absent on every
   * normal submit — and on a naming submit whose handle was invalid
   * (execute, skip save).
   */
  | { kind: 'submit'; line: string; saveName?: NamingState }
```

`existingHandles` (`:311`) wird ebenenbewusst:

```ts
/** Handles blocking this level, minus the one already owned by this line
 *  (renaming to itself is not a collision). */
function blockingFor(state: PromptState, ctx: HandlerContext, scope: NameScope): string[] {
  const own = ctx.names?.handleFor(state.line.trim(), ctx.cwd ?? '') ?? null;
  return (ctx.names?.blockingHandles(scope, ctx.cwd ?? '') ?? []).filter((handle) => handle !== own);
}
```

Der naming-Zweig (`:331`ff) arbeitet auf `state.naming.handle`:

```ts
  if (state.naming !== null) {
    const { handle, scope } = state.naming;
    if (key.escape || (key.ctrl && input === 'c')) {
      return update({ ...state, naming: null });
    }
    // ^G: same handle, other level. The badge recomputes its collision hint,
    // so a red "taken" can resolve by switching levels.
    if (key.ctrl && input === 'g') {
      return update({ ...state, naming: { handle, scope: scope === 'here' ? 'global' : 'here' } });
    }
    if (key.return) {
      if (handle === '') return { kind: 'submit', line: state.line, saveName: { handle: '', scope } };
      const valid = validateHandle(handle, state.line, blockingFor(state, ctx, scope));
      return valid !== null
        ? { kind: 'submit', line: state.line, saveName: { handle: valid, scope } }
        : { kind: 'submit', line: state.line };
    }
    if (key.ctrl && input === 'u') return update({ ...state, naming: { handle: '', scope } });
    if (key.backspace || key.delete) {
      return update({ ...state, naming: { handle: handle.slice(0, -1), scope } });
    }
    if (input && !key.ctrl && !key.meta) {
      const filtered = input.toLowerCase().replace(/[^a-z0-9]/g, '');
      return update({ ...state, naming: { handle: (handle + filtered).slice(0, 16), scope } });
    }
    return update(state);
  }
```

`Ctrl+N` (`:405`) prefillt beides:

```ts
    const existing = ctx.names.nameFor(state.line.trim(), ctx.cwd ?? '');
    return update({
      ...state,
      naming: existing === null ? { handle: '', scope: 'here' } : { handle: existing.name, scope: scopeOf(existing) },
    });
```

`initialPromptState` bleibt `naming: null`. Import in `prompt-state.ts` um `NameScope`, `scopeOf` erweitern.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

`npm run build` **bricht hier erwartungsgemäß**: `app.tsx` liest `naming` noch als String. Vitest typecheckt nicht, deshalb ist die Suite trotzdem grün. Task 8 schließt die Lücke — hier committen und direkt weitermachen, nicht versuchen, den Build in diesem Task zu retten.

- [ ] **Step 5: Commit**

```bash
git add src/repl/prompt-state.ts tests/repl/prompt-state.test.ts
git commit -m "feat(repl): the naming badge knows which level it is naming on"
```

---

### Task 7: `^S` — speichern, ohne auszuführen

**Files:**
- Modify: `src/repl/prompt-state.ts` (`KeyOutcome`, naming-Zweig)
- Test: `tests/repl/prompt-state.test.ts`

**Interfaces:**
- Consumes: `NamingState` (Task 6)
- Produces: `KeyOutcome` `| { kind: 'name'; line: string; saveName: NamingState; state: PromptState }`

- [ ] **Step 1: Write the failing test**

```ts
  it('Ctrl+S saves without executing and closes the badge', () => {
    const outcome = handleKey(typedState(LONG, naming('haiku', 'global')), key('s', { ctrl: true }), magicCtx(names()));
    expect(outcome).toEqual({
      kind: 'name',
      line: LONG,
      saveName: naming('haiku', 'global'),
      state: expect.objectContaining({ naming: null, line: LONG }),
    });
  });

  it('Ctrl+S on an empty badge is a forget, not a second delete path', () => {
    const index = names([{ name: 'haiku', line: LONG, cwds: [], ts: 1 }]);
    const outcome = handleKey(typedState(LONG, naming('')), key('s', { ctrl: true }), magicCtx(index));
    expect(outcome).toEqual({
      kind: 'forget',
      line: LONG,
      state: expect.objectContaining({ naming: null }),
    });
  });

  it('Ctrl+S with an invalid handle saves nothing and keeps the badge open', () => {
    // No execution hides the failure here, so the badge must stay put.
    const outcome = handleKey(typedState(LONG, naming('ab')), key('s', { ctrl: true }), magicCtx(names()));
    expect(outcome).toEqual({ kind: 'update', state: expect.objectContaining({ naming: naming('ab') }) });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repl/prompt-state.test.ts -t "Ctrl+S"`
Expected: FAIL — `^S` fällt in den Zeichenfilter, `naming` bleibt offen und unverändert.

- [ ] **Step 3: Write minimal implementation**

`KeyOutcome` erweitern, direkt nach dem `forget`-Eintrag:

```ts
  /**
   * ^S in the naming badge: persist the handle on its scope WITHOUT executing
   * the command — the mirror image of 'forget'. Needed because switching an
   * existing handle to global would otherwise have to run the command.
   * Persistence happens outside; `state` continues the prompt with the badge
   * closed.
   */
  | { kind: 'name'; line: string; saveName: NamingState; state: PromptState }
```

Im naming-Zweig **vor** dem Zeichenfilter (und vor `^U`, damit `s` nicht in den Filter fällt):

```ts
    if (key.ctrl && input === 's') {
      // An empty badge means "drop the name" — that is exactly what ^X does,
      // so reuse its outcome instead of building a second delete path.
      if (handle === '') {
        return ctx.names?.has(state.line.trim()) === true
          ? { kind: 'forget', line: state.line.trim(), state: { ...state, naming: null, selected: 0 } }
          : update({ ...state, naming: null });
      }
      const valid = validateHandle(handle, state.line, blockingFor(state, ctx, scope));
      // Nothing executes here, so an invalid handle must not vanish silently:
      // keep the badge open with its red hint.
      return valid === null
        ? update(state)
        : { kind: 'name', line: state.line, saveName: { handle: valid, scope }, state: { ...state, naming: null } };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/repl/prompt-state.ts tests/repl/prompt-state.test.ts
git commit -m "feat(repl): ^S commits a handle without running the command"
```

---

### Task 8: Badge-Anzeige, Toast und Persistenz im REPL

**Files:**
- Modify: `src/repl/app.tsx` (`AppProps` bei `:41`, `namingIssue` bei `:666`, Badge-Render bei `:728`, Outcome-Verarbeitung bei `:608`)
- Modify: `src/repl/run.ts` (`saveName`-Zweig bei `:336`, `onName`-Prop bei `:281`)
- Test: `tests/repl/app.test.ts`

**Interfaces:**
- Consumes: `NamingState`, `kind: 'name'` (Task 6, 7), `makeName` (Task 1), `blockingHandles` (Task 3)
- Produces:
  - `namingIssueFor(naming: NamingState, line: string, cwd: string, names: NameIndex | undefined): HandleIssue | null` — exportiert aus `app.tsx`
  - `namingBadge(naming: NamingState, issue: HandleIssue | null): { marker: string; hint: string }` — exportiert aus `app.tsx`
  - `AppProps.onName?: ((line: string, save: NamingState) => string) | undefined` — Rückgabe ist der Toast-Text, weil `run.ts` weiß, ob der Append die Datei erreicht hat (dasselbe Muster wie `onForgetHistory: (line) => number`)

**Hinweis zum Teststil:** `tests/repl/app.test.ts` rendert **nichts** — es importiert pure Funktionen aus `app.tsx` (`legendVisible`, `magicCandidates`, `acceptedLineFor`, …) und prüft deren Rückgaben. Deshalb wandert die Badge-Logik in zwei pure Funktionen, und das JSX bleibt dumm. Das ist das etablierte Muster der Datei, keine Erfindung dieses Plans.

- [ ] **Step 1: Write the failing test**

An `tests/repl/app.test.ts` anhängen:

```ts
describe('naming badge', () => {
  const CWD = '/home/dev/project';
  const LONG = 'docker compose run php vendor/bin/phpstan analyze src';

  it('marks the level it would save on', () => {
    expect(namingBadge({ handle: 'haiku', scope: 'here' }, null).marker).toBe('⚡');
    expect(namingBadge({ handle: 'haiku', scope: 'global' }, null).marker).toBe('🌐');
  });

  it('offers the opposite level in the hint', () => {
    expect(namingBadge({ handle: 'haiku', scope: 'here' }, null).hint).toContain('^G: global');
    expect(namingBadge({ handle: 'haiku', scope: 'global' }, null).hint).toContain('^G: nur hier');
  });

  it('always advertises both commit keys', () => {
    const { hint } = namingBadge({ handle: 'haiku', scope: 'here' }, null);
    expect(hint).toContain('^S: save');
    expect(hint).toContain('enter: save+run');
  });

  it('appends the reason a save would be skipped', () => {
    expect(namingBadge({ handle: 'dep', scope: 'here' }, 'taken').hint).toContain('taken');
    expect(namingBadge({ handle: 'docker', scope: 'here' }, 'command').hint).toContain('= command name');
  });

  it('reports a collision only on the level being named on', () => {
    const index = new NameIndex([{ name: 'dep', line: 'other command', cwds: [CWD], ts: 1 }]);
    expect(namingIssueFor({ handle: 'dep', scope: 'here' }, LONG, CWD, index)).toBe('taken');
    // Going global with a locally taken handle is the whole point.
    expect(namingIssueFor({ handle: 'dep', scope: 'global' }, LONG, CWD, index)).toBeNull();
  });

  it('renaming a command to its own handle is no collision', () => {
    const index = new NameIndex([{ name: 'dep', line: LONG, cwds: [CWD], ts: 1 }]);
    expect(namingIssueFor({ handle: 'dep', scope: 'here' }, LONG, CWD, index)).toBeNull();
  });

  it('stays quiet on an empty badge and without an index', () => {
    expect(namingIssueFor({ handle: '', scope: 'here' }, LONG, CWD, new NameIndex())).toBeNull();
    expect(namingIssueFor({ handle: 'dep', scope: 'here' }, LONG, CWD, undefined)).toBeNull();
  });
});
```

Die Import-Zeile von `app.js` um `namingBadge`, `namingIssueFor` erweitern und `NameIndex` aus `../../src/engine/names.js` importieren.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repl/app.test.ts -t "naming badge"`
Expected: FAIL — „does not provide an export named 'namingBadge'".

- [ ] **Step 3: Write minimal implementation**

In `src/repl/app.tsx`, bei den anderen exportierten Helfern (neben `magicCandidates`, `:148`):

```ts
/**
 * Live badge validation: red only for a real conflict ON THE LEVEL being
 * named on — a handle taken in another directory is no conflict, and a
 * global one may be shadowed locally. "Too short" stays quiet while typing
 * and only skips the save.
 */
export function namingIssueFor(
  naming: NamingState,
  line: string,
  cwd: string,
  names: NameIndex | undefined,
): HandleIssue | null {
  if (naming.handle === '' || names === undefined) return null;
  // Renaming a command to the handle it already owns is not a collision.
  const own = names.handleFor(line.trim(), cwd);
  return handleIssue(
    naming.handle,
    line,
    names.blockingHandles(naming.scope, cwd).filter((handle) => handle !== own),
  );
}

/** Marker and hint line of the naming badge — the badge itself stays dumb. */
export function namingBadge(
  naming: NamingState,
  issue: HandleIssue | null,
): { marker: string; hint: string } {
  const level = naming.scope === 'global' ? 'GLOBAL · ^G: nur hier' : 'hier · ^G: global';
  const reason = issue === 'taken' ? ' · taken' : issue === 'command' ? ' · = command name' : '';
  return {
    marker: naming.scope === 'global' ? '🌐' : '⚡',
    hint: `  ${level} · ^S: save · enter: save+run · esc: cancel${reason}`,
  };
}
```

Den `namingIssue`-Block (`:666`) darauf zurückschneiden:

```ts
  const namingIssue: HandleIssue | null = naming !== null ? namingIssueFor(naming, line, cwd, names) : null;
```

`ownHandle` (`:665`) wird dort nicht mehr gebraucht — nur entfernen, wenn es keine weiteren Leser hat (prüfen: `grep -n ownHandle src/repl/app.tsx`).

Badge-Render (`:728`):

```ts
      ) : naming !== null ? (
        <Box>
          <Text backgroundColor={namingIssue !== null ? 'red' : 'blue'} color="whiteBright" bold>
            {` ${namingBadge(naming, namingIssue).marker} ${naming.handle}▏ `}
          </Text>
          <Text dimColor>{namingBadge(naming, namingIssue).hint}</Text>
        </Box>
```

Alle weiteren `naming !== null`-Vergleiche in `app.tsx` (Ghost `:657`, Discovery `:673`, Toast/Legend `:842`/`:847`) bleiben unverändert — sie prüfen nur auf `null`.

`AppProps` (`:41`) ergänzen:

```ts
  /** ^S: persist a handle without executing. Returns the toast to show. */
  onName?: ((line: string, save: NamingState) => string) | undefined;
```

`PromptApp`-Destrukturierung (`:426`) um `onName` erweitern, und nach dem `forget`-Zweig (`:621`):

```ts
    if (outcome.kind === 'name') {
      // Saved without executing: the prompt stays open, the bumped version
      // recomputes the prediction with the new handle in play.
      const toastText = onName?.(outcome.line, outcome.saveName) ?? 'could not save the handle';
      setNamesVersion((version) => version + 1);
      setToast(toastText);
      return setState(outcome.state);
    }
```

In `src/repl/run.ts` den `saveName`-Zweig (`:336`) umstellen:

```ts
    if (magicEnabled && result.saveName !== undefined) {
      if (result.saveName.handle === '') {
        // Empty badge on a previously named command = delete (tombstone);
        // on an unnamed one it is just the escape hatch — nothing to do.
        if (nameIndex.has(line)) {
          nameIndex.remove(line);
          appendTombstone(namesFile, line, Date.now());
        }
      } else {
        const magicName = makeName(result.saveName.handle, line, result.saveName.scope, cwd, Date.now());
        nameIndex.add(magicName);
        appendName(namesFile, magicName);
      }
    }
```

Und den `onName`-Handler im selben `magicEnabled`-Spread registrieren, in dem `onForget` steht (`:281`ff):

```ts
            // ^S: persist without executing. The toast reports what actually
            // happened — appendName can silently fail on a busy lock.
            onName: (named: string, save: NamingState): string => {
              const magicName = makeName(save.handle, named.trim(), save.scope, cwd, Date.now());
              if (!appendName(namesFile, magicName)) return 'names file is busy — nothing saved';
              nameIndex.add(magicName);
              return save.scope === 'global'
                ? `🌐 ${save.handle} applies everywhere`
                : `⚡ ${save.handle} applies here`;
            },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — inklusive der in Task 6 migrierten Tests.

- [ ] **Step 5: Commit**

```bash
git add src/repl/app.tsx src/repl/run.ts tests/repl/app.test.ts
git commit -m "feat(repl): the badge shows its level, ^S reports what it saved"
```

---

### Task 9: `:names` zeigt den Scope

**Files:**
- Modify: `src/repl/run.ts:68-77` (`:names`-Daten)
- Modify: `src/repl/app.tsx:203` (`ReplOutput`), `src/repl/app.tsx:229-250` (Panel)
- Test: `tests/repl/app.test.ts`

**Interfaces:**
- Consumes: `scopeOf`, `activeIn` (Task 1)
- Produces: `ReplOutput` `names`-Zeilen tragen `scope: NameScope`

- [ ] **Step 1: Write the failing test**

`handleReplCommand` ist in `tests/repl/app.test.ts` bereits importiert und wird dort mit einem `showOutput`-Sammler geprüft (Muster bei `:78-87`). Diesem Muster folgen:

```ts
describe(':names reports the scope', () => {
  const CWD = '/home/dev/project';

  it('hands the panel a scope per handle', () => {
    const output: ReplOutput[] = [];
    const names = [
      { name: 'haiku', line: 'claude --model haiku', cwds: [], ts: 2 },
      { name: 'dep', line: 'docker compose exec php composer install', cwds: [CWD], ts: 1 },
    ];

    expect(handleReplCommand(':names', { ...context, cwd: CWD, names, showOutput: (v) => output.push(v) })).toBe('handled');
    expect(output[0]).toEqual({
      kind: 'names',
      names: [
        { name: 'haiku', line: 'claude --model haiku', active: true, scope: 'global' },
        { name: 'dep', line: 'docker compose exec php composer install', active: true, scope: 'here' },
      ],
    });
  });

  it('keeps a foreign handle listed but inactive', () => {
    const output: ReplOutput[] = [];
    const names = [{ name: 'dep', line: 'cargo build', cwds: ['/elsewhere'], ts: 1 }];

    handleReplCommand(':names', { ...context, cwd: CWD, names, showOutput: (v) => output.push(v) });
    expect(output[0]).toMatchObject({ names: [{ name: 'dep', active: false, scope: 'here' }] });
  });
});
```

`context` ist das bestehende Objekt der Datei, mit dem die anderen `handleReplCommand`-Tests arbeiten. Die erwartete Reihenfolge ergibt sich aus der vorhandenen Sortierung (`active` zuerst, dann `ts` absteigend) — schlägt der Test darauf an, ist die Sortierung die Wahrheit und die Erwartung anzupassen, nicht umgekehrt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/repl/app.test.ts -t ":names reports"`
Expected: FAIL — die Ausgabezeilen haben kein `scope`.

- [ ] **Step 3: Write minimal implementation**

`src/repl/app.tsx:203`:

```ts
  | { kind: 'names'; names: readonly { name: string; line: string; active: boolean; scope: NameScope }[] }
```

Panel (`:229`) — eine Marker-Spalte vor dem Handle:

```ts
    case 'names': {
      const nameWidth = Math.min(18, Math.max(6, ...output.names.map((n) => n.name.length)) + 2);
      return (
        <MagicPanel title="names" {...(output.names.length > 0 ? { subtitle: `${output.names.length} learned` } : {})}>
          {output.names.length === 0 ? (
            <Text dimColor>No magic names yet — Ctrl-N on a typed command creates one.</Text>
          ) : (
            output.names.map((entry) => (
              <Box key={`${entry.name}${entry.line}`}>
                <Box width={2}>
                  <Text dimColor={!entry.active}>{entry.scope === 'global' ? '🌐' : '⚡'}</Text>
                </Box>
                <Box width={nameWidth}>
                  {entry.active ? <Text color="magenta" bold>{entry.name}</Text> : <Text dimColor>{entry.name}</Text>}
                </Box>
                <Text dimColor={!entry.active}>{truncateEnd(singleLine(entry.line), contentWidth - nameWidth - 4)}</Text>
              </Box>
            ))
          )}
          {output.names.some((entry) => !entry.active) && (
            <Text dimColor>dimmed: belong to other directories · 🌐 applies everywhere</Text>
          )}
        </MagicPanel>
      );
    }
```

`src/repl/run.ts:68` — `scope` mitgeben:

```ts
        names: sorted.map((name) => ({
          name: name.name,
          line: name.line,
          active: isActive(name),
          scope: scopeOf(name),
        })),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/repl/app.tsx src/repl/run.ts tests/repl/app.test.ts
git commit -m "feat(repl): :names says where each handle applies"
```

---

### Task 10: `tabcat names` zeigt den Scope

**Files:**
- Modify: `src/engine/names.ts` (neu: `formatNamesList`)
- Modify: `src/cli.ts:152-161`
- Test: `tests/engine/names.test.ts`

**Interfaces:**
- Consumes: `scopeOf`, `isGlobal` (Task 1)
- Produces: `formatNamesList(names: readonly MagicName[]): string[]`

**Warum in `names.ts`:** die Spalte braucht das Verzeichnis eines Handles, also `cwds`. In `cli.ts` würde das den Guard aus Task 5 auslösen — und zu Recht. Als pure Funktion im Besitzer-Modul ist sie zugleich ohne CLI-Harness testbar (es gibt `tests/cli-args.test.ts`, `cli-daemon.test.ts` und `cli-settings.test.ts`, aber keinen Runner für Ausgabe-Unterbefehle).

- [ ] **Step 1: Write the failing test**

An `tests/engine/names.test.ts` anhängen:

```ts
describe('names: formatNamesList', () => {
  it('aligns handle, scope and command', () => {
    const lines = formatNamesList([
      name({ name: 'haiku', line: 'claude --model haiku', cwds: [] }),
      name({ name: 'dep', line: 'npm ci', cwds: ['/projects/a'] }),
    ]);

    expect(lines[0]).toMatch(/^haiku\s+everywhere\s+claude --model haiku$/);
    expect(lines[1]).toMatch(/^dep\s+\/projects\/a\s+npm ci$/);
    // Same column start for both rows — the point of the padding.
    expect(lines[0]?.indexOf('everywhere')).toBe(lines[1]?.indexOf('/projects/a'));
  });

  it('returns no lines for an empty index', () => {
    expect(formatNamesList([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/names.test.ts -t "formatNamesList"`
Expected: FAIL — kein Export `formatNamesList`.

- [ ] **Step 3: Write minimal implementation**

In `src/engine/names.ts` nach `makeName`:

```ts
/**
 * `tabcat names` rows, aligned. Lives here because the scope column needs
 * `cwds`, which no other module may read — and being pure makes it testable
 * without a CLI harness.
 */
export function formatNamesList(names: readonly MagicName[]): string[] {
  if (names.length === 0) return [];
  // The column answers what the flat list used to leave open: why a handle
  // does nothing in the directory you are standing in.
  const where = (name: MagicName): string => (isGlobal(name) ? 'everywhere' : (name.cwds[0] ?? ''));
  const handleWidth = Math.max(...names.map((name) => name.name.length));
  const whereWidth = Math.max(...names.map((name) => where(name).length));
  return names.map(
    (name) => `${name.name.padEnd(handleWidth)}  ${where(name).padEnd(whereWidth)}  ${name.line}`,
  );
}
```

`src/cli.ts:152` — die Ausgabeschleife ersetzen, den Rest des `case` unverändert lassen:

```ts
    for (const row of formatNamesList(names)) console.log(row);
```

Die beiden Zeilen `const width = …` und die alte `for`-Schleife entfallen. `formatNamesList` importieren; `namesFileFor`/`readNames` bleiben.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`

Zusätzlich manuell:
```bash
npm run build && node dist/cli.js names
```
Expected: drei Spalten, globale Handles mit `everywhere`.

- [ ] **Step 5: Commit**

```bash
git add src/engine/names.ts src/cli.ts tests/engine/names.test.ts
git commit -m "feat(cli): tabcat names shows where a handle applies"
```

---

### Task 11: Daemon — `create-global` ohne Arity-Änderung

**Files:**
- Modify: `src/daemon/protocol.ts:228-243`
- Modify: `src/daemon/engine-host.ts:211-233` (`namesCreate`)
- Modify: `src/daemon/server.ts:368-375`
- Test: `tests/daemon/protocol.test.ts`, `tests/daemon/engine-host.test.ts`

**Interfaces:**
- Consumes: `makeName`, `blockingHandles`, `NameScope` (Task 1, 3)
- Produces:
  - `DaemonRequest` `names.sub` union gewinnt `'create-global'`
  - `EngineHost.namesCreate(name: string, line: string, cwd: string, scope: NameScope): NamesCreateResult`

- [ ] **Step 1: Write the failing test**

`tests/daemon/protocol.test.ts`:

```ts
  it('parses create-global without changing the field count', () => {
    const line = ['names', 'r1', String(PROTOCOL_VERSION), 'create-global', '/p', 'haiku', 'claude --model haiku'].join('\t');
    const parsed = parseRequest(line);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request).toMatchObject({ op: 'names', sub: 'create-global', name: 'haiku' });
  });

  it('still validates the handle on create-global', () => {
    const line = ['names', 'r1', String(PROTOCOL_VERSION), 'create-global', '/p', 'AB', 'x'].join('\t');
    expect(parseRequest(line).ok).toBe(false);
  });

  it('keeps names at 7 fields — the Swift GUI sends exactly that', () => {
    const short = ['names', 'r1', String(PROTOCOL_VERSION), 'list', '/p', '', ''].join('\t');
    expect(parseRequest(short).ok).toBe(true);
    const eight = [...short.split('\t'), 'extra'].join('\t');
    expect(parseRequest(eight).ok).toBe(false);
  });

  it('rejects an unknown sub as before', () => {
    const line = ['names', 'r1', String(PROTOCOL_VERSION), 'create-globl', '/p', 'haiku', 'x'].join('\t');
    expect(parseRequest(line).ok).toBe(false);
  });
```

`tests/daemon/engine-host.test.ts`:

```ts
  it('creates a global handle that resolves from any directory', () => {
    const host = makeHost();
    expect(host.namesCreate('haiku', 'claude --model haiku', '/projects/a', 'global').created).toBe(true);
    expect(host.resolveHandle('haiku', '/projects/b')).toBe('claude --model haiku');
  });

  it('a local handle elsewhere does not block going global', () => {
    const host = makeHost();
    host.namesCreate('dep', 'cargo build', '/projects/a', 'here');
    expect(host.namesCreate('dep', 'npm ci', '/projects/b', 'global').created).toBe(true);
    expect(host.resolveHandle('dep', '/projects/a')).toBe('cargo build');
    expect(host.resolveHandle('dep', '/projects/b')).toBe('npm ci');
  });

  it('a handle taken on the same level is still rejected', () => {
    const host = makeHost();
    host.namesCreate('haiku', 'claude --model haiku', '/projects/a', 'global');
    expect(host.namesCreate('haiku', 'other command', '/projects/b', 'global')).toEqual({
      created: false,
      reason: 'taken',
    });
  });
```

`makeHost()` ist der Helper der Datei; die bestehenden `namesCreate`-Aufrufe in dieser Testdatei um das vierte Argument `'here'` ergänzen.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon`
Expected: FAIL — `create-global` wird als `bad_value` abgewiesen; `namesCreate` nimmt kein viertes Argument.

- [ ] **Step 3: Write minimal implementation**

`src/daemon/protocol.ts` — Typ (`:40`):

```ts
  | { op: 'names'; id: string; sub: 'list' | 'create' | 'create-global' | 'delete' | 'resolve'; cwd: string; name: string; line: string }
```

Parser (`:228`):

```ts
    case 'names': {
      const sub = fields[3] ?? '';
      if (sub !== 'list' && sub !== 'create' && sub !== 'create-global' && sub !== 'delete' && sub !== 'resolve') {
        return fail(rawId, 'bad_value', `unknown names op: ${truncate(sub)}`);
      }
      const cwd = value(4);
      if (cwd === '') return fail(rawId, 'bad_value', 'cwd must not be empty');
      const name = value(5);
      const line = value(6);
      // A scope rides in the sub, not in an eighth field: FIELD_COUNT is
      // checked strictly and the Swift GUI sends exactly 7 fields.
      if (sub === 'create' || sub === 'create-global') {
        if (!HANDLE_PATTERN.test(name)) return fail(rawId, 'bad_value', `invalid handle: ${truncate(name)}`);
        if (line.trim() === '') return fail(rawId, 'bad_value', 'line must not be empty');
      }
```

`FIELD_COUNT` bleibt unverändert bei `names: 7`.

`src/daemon/engine-host.ts` — `namesCreate` (`:211`):

```ts
  namesCreate(name: string, line: string, cwd: string, scope: NameScope): NamesCreateResult {
    this.refreshNames();
    // Same guard as the REPL naming badge: the handle must be free on THIS
    // level and must not shadow the command's own program name.
    const handles = this.nameIndex.blockingHandles(scope, cwd);
    const accepted = validateHandle(name, line, handles);
    if (accepted === null) {
      return { created: false, reason: handleIssue(name.toLowerCase(), line, handles) ?? 'malformed' };
    }
    const magicName = makeName(accepted, line, scope, cwd, this.now());
```

Rest der Methode unverändert.

`src/daemon/server.ts` (`:368`):

```ts
      if (request.sub === 'create' || request.sub === 'create-global') {
        const scope: NameScope = request.sub === 'create-global' ? 'global' : 'here';
        const result = host.namesCreate(request.name, request.line, request.cwd, scope);
        return {
          response: result.created
            ? ok(request.id, 'created')
            : err(request.id, 'bad_value', result.reason ?? 'rejected'),
        };
      }
```

Imports (`NameScope`, `makeName`) in beiden Dateien ergänzen.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/protocol.ts src/daemon/engine-host.ts src/daemon/server.ts tests/daemon/
git commit -m "feat(daemon): create-global rides in the sub, sparing the wire"
```

---

### Task 12: zsh-Plugin — `^XL`

**Files:**
- Modify: `src/plugin/tabcat.plugin.zsh` (Config `:42`, `tabcat-label` `:726`, `zle -N` `:1052`, Bindings `:1064`)
- Test: `tests/plugin/behavior.test.ts` (Binding), `tests/plugin/integration.test.ts` (Daemon-Runde)

**Interfaces:**
- Consumes: `names create-global` (Task 11)
- Produces: Widget `tabcat-label-global`, Variable `TABCAT_KEY_LABEL_GLOBAL` (Default `^XL`)

**Teststil:** Plugin-Tests sind zsh-Skripte über den Harness (`tests/plugin/harness.ts`: `runZsh`, `withPlugin`). Bindings werden mit `bindkey '<chord>'` inspiziert (`behavior.test.ts:283`), Daemon-Operationen direkt über `_tabcat_request` gefahren (`integration.test.ts:166`). Kein zpty nötig.

- [ ] **Step 1: Write the failing test**

In `tests/plugin/behavior.test.ts`, bei den anderen Binding-Tests (dem `inspect`-Helper der Datei folgen, Muster `:197-206`):

```ts
  it('binds ^XL to the global label widget', () => {
    const out = inspect(`bindkey '^XL'`);
    expect(out).toContain('"^XL" tabcat-label-global');
  });

  it('leaves ^Xl on the directory-scoped widget', () => {
    const out = inspect(`bindkey '^Xl'`);
    expect(out).toContain('"^Xl" tabcat-label');
  });

  it('honors TABCAT_KEY_LABEL_GLOBAL', () => {
    const out = inspect(`bindkey '^Xy'`, { env: { TABCAT_KEY_LABEL_GLOBAL: '^Xy' } });
    expect(out).toContain('"^Xy" tabcat-label-global');
  });
```

Nimmt `inspect` kein `env`-Override, das Muster der benachbarten Konfigurationstests dieser Datei verwenden.

In `tests/plugin/integration.test.ts`, neben dem bestehenden `names create`-Test (`:166`):

```ts
      _tabcat_request names create-global $cwd haiku $line || { print "CREATE FAILED"; return 1 }
```

als vollständiges Skript im Stil des Nachbartests, plus die Auflösung aus einem **anderen** Verzeichnis:

```ts
  it('a global handle resolves from any directory', () => {
    const script = withPlugin(`
      local line='claude --dangerously-skip-permissions --model haiku'
      local cwd=/projects/a
      _tabcat_request names create-global $cwd haiku $line || { print "CREATE FAILED"; return 1 }
      _tabcat_request names resolve /projects/b haiku '' || { print "RESOLVE FAILED"; return 1 }
      local -a header=("\${(@ps:\t:)_TABCAT_ROWS[1]}")
      _tabcat_dec "\${header[3]:-}"
      print "resolved=$REPLY${ROW}"
    `);
    const out = runZsh(script, { env: daemonEnv });
    expect(out.stdout).toContain('resolved=claude --dangerously-skip-permissions --model haiku');
  });
```

`daemonEnv` bzw. die Daemon-Vorbereitung aus dem benachbarten `names create`-Test übernehmen — dieselbe Fixture, nicht eine zweite.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugin/behavior.test.ts -t "^XL"`
Expected: FAIL — `bindkey '^XL'` meldet „no such key binding".

- [ ] **Step 3: Write minimal implementation**

Config (`:42`), nach `TABCAT_KEY_LABEL`:

```sh
: ${TABCAT_KEY_LABEL_GLOBAL:='^XL'}
```

`tabcat-label` (`:726`) wird ein Rumpf mit Scope-Argument, plus zwei dünne Widgets:

```sh
# $1: 'here' (default) or 'global' — decides the daemon sub, nothing else.
_tabcat_label_scoped() {
  emulate -L zsh
  local scope=${1:-here}
  local line=$BUFFER
  if [[ -z ${line//[[:space:]]/} ]]; then
    zle -M "tabcat: nothing to name"
    return
  fi
  local REPLY
  local _TABCAT_IN_PROMPT=1
  local label="tabcat handle (3-16, a-z0-9): "
  [[ $scope == global ]] && label="tabcat handle, global (3-16, a-z0-9): "
  read-from-minibuffer "$label" || return
  local handle=${REPLY//[[:space:]]/}
  [[ -z $handle ]] && return
  if [[ ! $handle =~ '^[a-z][a-z0-9]{2,15}$' ]]; then
    zle -M "tabcat: '$handle' is not a valid handle (start with a letter, 3-16 of a-z0-9)"
    return
  fi
  local cwd escaped escaped_handle sub=create
  [[ $scope == global ]] && sub=create-global
  _tabcat_esc "$PWD"; cwd=$REPLY
  _tabcat_esc "$line"; escaped=$REPLY
  _tabcat_esc "$handle"; escaped_handle=$REPLY
  if _tabcat_request names $sub "$cwd" "$escaped_handle" "$escaped"; then
    if [[ $scope == global ]]; then
      zle -M "tabcat: 🌐$handle -> $line (everywhere)"
    else
      zle -M "tabcat: ⚡$handle -> $line"
    fi
  else
    local -a header=("${(@ps:\t:)_TABCAT_ROWS[1]:-}")
    zle -M "tabcat: handle rejected (${header[4]:-no daemon})"
  fi
  _tabcat_ghost
}

tabcat-label() { _tabcat_label_scoped here }
tabcat-label-global() { _tabcat_label_scoped global }
```

Widget registrieren (`:1052`), neben `zle -N tabcat-label`:

```sh
  zle -N tabcat-label-global
```

Binding bei den anderen `_tabcat_bind`-Aufrufen mit `$TABCAT_KEY_*` ergänzen, demselben Muster folgend:

```sh
  _tabcat_bind tabcat-label-global "$TABCAT_KEY_LABEL_GLOBAL" $insert_maps
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Der Integrationstest braucht ein gebautes `dist` — falls die Suite das nicht selbst erledigt, vorher `npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/plugin/tabcat.plugin.zsh tests/plugin/behavior.test.ts tests/plugin/integration.test.ts
git commit -m "feat(plugin): ^XL labels a command for every directory"
```

---

### Task 13: README

**Files:**
- Modify: `README.md` (REPL-Tastentabelle `:63`, Magic-Names-Abschnitt `:78-91`, Plugin-Tastentabelle `:160-170`, Konfigurationstabelle `:175-180`)

**Interfaces:**
- Consumes: alles Vorherige
- Produces: nichts

- [ ] **Step 1: REPL-Tastentabelle ergänzen**

Nach der `Ctrl+N`-Zeile:

```markdown
| `Ctrl+N` | Name this command (magic name) |
| `Ctrl+G` | In the naming badge: switch between *this directory* and *everywhere* |
| `Ctrl+S` | In the naming badge: save without running the command |
```

- [ ] **Step 2: Magic-Names-Abschnitt ergänzen**

Den `**Scope:**`-Punkt ersetzen:

```markdown
- **Scope:** a handle belongs to the directory it was created in and never surfaces elsewhere (relative paths stay safe). Press `Ctrl+G` in the badge to make it apply **everywhere** instead — right for commands without a place, like `claude --model haiku`. The badge says which one you are on: `⚡ here` or `🌐 GLOBAL`.
- **Both at once:** the nearer handle wins. A local `dep` and a global `dep` can coexist — in the directory that defines the local one it resolves there, everywhere else to the global one. A name is only "taken" on the level you are naming on, so `Ctrl+G` can clear a red badge.
- **Switching later:** type the handle, `Tab` to expand it, `Ctrl+N` to reopen the badge (handle and scope prefilled), `Ctrl+G`, then `Ctrl+S` — saves without running the command.
```

- [ ] **Step 3: Plugin-Tabelle und Konfiguration ergänzen**

Nach der `^Xl`-Zeile:

```markdown
| `^XL` | G**l**obal label: name the current command for every directory (same action as `^Xl`, uppercase — `^Xg`/`^XG` are taken by zsh's builtin `list-expand`) |
```

In der Konfigurationstabelle die Key-Zeile ersetzen:

```markdown
| `TABCAT_KEY_LABEL` / `_LABEL_GLOBAL` / `_FORGET` / `_QUERY` / `_MENU` | `^Xl` / `^XL` / `^Xf` / `^Xq` / `^Xv` | Rebind the chords |
```

- [ ] **Step 4: Verify**

Run: `grep -n "Ctrl+G\|\^XL\|LABEL_GLOBAL" README.md`
Expected: alle drei Tabellen und der Magic-Names-Abschnitt getroffen.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): a handle can belong everywhere"
```

---

## Nach dem letzten Task

- [ ] `npm test` — vollständige Suite grün
- [ ] `npm run build` — `tsc` sauber
- [ ] Manuelle Prüfung im REPL: `Ctrl+N` → `^G` → `^S` auf einem bestehenden Handle; das Kommando darf **nicht** starten
- [ ] Manuelle Prüfung, ob `^S` unter tmux ankommt (Spec-Vorbehalt). Klemmt es: `^O` als Taste, README und Badge-Hint mitziehen, und in der Spec vermerken — gemessen, nicht erinnert
- [ ] Daemon nach dem Build einmal stoppen (`tabcat daemon stop`), damit das Plugin gegen den neuen `create-global`-Sub läuft
