import { lex } from './lexer.js';
import type { RankedCandidate } from './predictor.js';

/**
 * A user-assigned shortcut ("magic name"): a short handle that expands back
 * to the full command line. Purely additive — handles only add ways to reach
 * an existing command, they never block or rewrite anything.
 */
export interface MagicName {
  /** The handle the user types, e.g. `phpstananalyze`. Lowercase, alphanumeric. */
  name: string;
  /** The full command line the handle expands to (stored verbatim, trimmed). */
  line: string;
  /**
   * Directories where the handle is valid. For a user-created shortcut this is
   * exactly the directory it was created in: `[cwd]`. Empty array =
   * context-free (surfaces everywhere).
   */
  cwds: string[];
  /** When created/updated (epoch millis). Newest wins on collision. */
  ts: number;
}

/** Magic candidates rank above every frecency score — the user asked for them by name. */
export const MAGIC_SCORE = 1_000_000;

/**
 * Handle shape: starts with a letter, letters/digits only, 3–16 chars. The
 * upper bound fits `tool+action` forms like `phpstananalyze`; the lower bound
 * keeps it a real handle.
 */
export const HANDLE_PATTERN = /^[a-z][a-z0-9]{2,15}$/;

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

/**
 * More specific first, then newest — the comparator resolve, match and
 * handleForPrefix share. Only for lists already filtered by activeIn; the
 * `?? 0` is a guard against misuse, not an expected case.
 */
const bySpecificity =
  (cwd: string) =>
  (a: MagicName, b: MagicName): number =>
    (specificityOf(a, cwd) ?? 0) - (specificityOf(b, cwd) ?? 0) || b.ts - a.ts;

/** First `word` chunk of the lexed line, or ''. */
export function firstWord(line: string): string {
  return lex(line).find((chunk) => chunk.kind === 'word')?.text ?? '';
}

export type HandleIssue = 'taken' | 'command';

/**
 * Content-level rejection reasons beyond the shape pattern — surfaced live in
 * the naming badge ('taken' / '= command name') before Enter even happens.
 */
export function handleIssue(name: string, command: string, existing: readonly string[]): HandleIssue | null {
  // Redundant with the program name — typing it would collide and save nothing.
  if (name === firstWord(command).toLowerCase()) return 'command';
  if (existing.some((handle) => handle.toLowerCase() === name)) return 'taken';
  return null;
}

/**
 * Normalizes and validates a proposed handle. Returns the accepted
 * (lowercased) handle or null.
 */
export function validateHandle(proposed: string, command: string, existing: readonly string[]): string | null {
  const name = proposed.toLowerCase();
  if (!HANDLE_PATTERN.test(name)) return null;
  return handleIssue(name, command, existing) === null ? name : null;
}

/**
 * In-memory handle index, keyed by command line — latest `ts` wins.
 * Deliberately additive: it can only add ways to find an existing command.
 */
export class NameIndex {
  private readonly byLine = new Map<string, MagicName>();

  constructor(names: readonly MagicName[] = []) {
    for (const name of names) this.add(name);
  }

  add(name: MagicName): void {
    const current = this.byLine.get(name.line);
    if (current === undefined || name.ts >= current.ts) this.byLine.set(name.line, name);
  }

  remove(line: string): void {
    this.byLine.delete(line);
  }

  /**
   * Replaces the whole index in place. The Predictor keeps this instance by
   * reference, so reloading names.jsonl (daemon: another shell created a
   * handle) must mutate the existing index instead of building a new one —
   * otherwise the reload would force a full predictor rebuild.
   */
  reset(names: readonly MagicName[]): void {
    this.byLine.clear();
    for (const name of names) this.add(name);
  }

  /** Is this command already named? */
  has(line: string): boolean {
    return this.byLine.has(line);
  }

  /** The record for an EXACT line, if one exists and applies in `cwd`. */
  nameFor(line: string, cwd: string): MagicName | null {
    const name = this.byLine.get(line);
    return name !== undefined && activeIn(name, cwd) ? name : null;
  }

  /** Handle for an EXACT line — powers the discovery badge. */
  handleFor(line: string, cwd: string): string | null {
    return this.nameFor(line, cwd)?.name ?? null;
  }

  /**
   * Handle of a named command the typed text is on its way to — a prefix match,
   * so the plugin badge can appear while typing instead of only once the line is
   * complete. Closest completion first (shortest command), newest wins ties.
   * `minLength` keeps a single character from matching half the index.
   */
  handleForPrefix(typed: string, cwd: string, minLength = 2): string | null {
    const text = typed.trimStart();
    if (text.trim().length < minLength) return null;
    const cmp = bySpecificity(cwd);
    const hits = [...this.byLine.values()]
      .filter((name) => name.line.startsWith(text) && activeIn(name, cwd))
      .sort((a, b) => a.line.length - b.line.length || cmp(a, b));
    return hits[0]?.name ?? null;
  }

  /** Handles in use (collision guard). With `cwd`, only handles active there —
   *  the same handle in an unrelated directory never surfaces, so it is no
   *  collision. */
  handles(cwd?: string): string[] {
    return [...this.byLine.values()]
      .filter((name) => cwd === undefined || activeIn(name, cwd))
      .map((name) => name.name);
  }

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

  all(): MagicName[] {
    return [...this.byLine.values()];
  }

  /** The command a handle expands to in `cwd` — exact name match only, newest wins. */
  resolve(handle: string, cwd: string): string | null {
    const wanted = handle.toLowerCase();
    const hits = [...this.byLine.values()]
      .filter((name) => name.name === wanted && activeIn(name, cwd))
      .sort(bySpecificity(cwd));
    return hits[0]?.line ?? null;
  }

  /**
   * Magic candidates for a typed first-token `prefix` in `cwd`: handles where
   * `prefix` is a case-insensitive prefix, shorter handle first, then newest.
   * `display` REPLACES the typed handle on accept — that is the resolution.
   */
  match(prefix: string, cwd: string): RankedCandidate[] {
    const wanted = prefix.toLowerCase();
    const cmp = bySpecificity(cwd);
    const seen = new Set<string>();
    return [...this.byLine.values()]
      .filter((name) => name.name.startsWith(wanted) && activeIn(name, cwd))
      .sort((a, b) => a.name.length - b.name.length || cmp(a, b))
      // One row per handle: a local and a global `dep` would otherwise appear
      // twice with different resolutions. Sorted first, so this keeps the
      // most specific record.
      .filter((name) => (seen.has(name.name) ? false : (seen.add(name.name), true)))
      .map((name, index) => ({
        display: name.line,
        // insert gates the accept machinery ('' = dead key/cycle) — it must
        // stay non-empty as long as accepting would change the line, even
        // when the handle is longer than the command it expands to.
        insert: name.line === prefix ? '' : name.line.slice(prefix.length) || name.line,
        score: MAGIC_SCORE - index,
        source: 'magic' as const,
        magicName: name.name,
        acceptedPrefixLength: prefix.length,
        replacePrefixLength: prefix.length,
      }));
  }
}
