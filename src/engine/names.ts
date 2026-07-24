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

const cwdMatches = (name: MagicName, cwd: string): boolean =>
  name.cwds.length === 0 || name.cwds.includes(cwd);

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

  /** Handle for an EXACT line, if one exists and is valid in `cwd` — powers the discovery badge. */
  handleFor(line: string, cwd: string): string | null {
    const name = this.byLine.get(line);
    return name !== undefined && cwdMatches(name, cwd) ? name.name : null;
  }

  /** Handles in use (collision guard). With `cwd`, only handles active there —
   *  the same handle in an unrelated directory never surfaces, so it is no
   *  collision. */
  handles(cwd?: string): string[] {
    return [...this.byLine.values()]
      .filter((name) => cwd === undefined || cwdMatches(name, cwd))
      .map((name) => name.name);
  }

  all(): MagicName[] {
    return [...this.byLine.values()];
  }

  /** The command a handle expands to in `cwd` — exact name match only, newest wins. */
  resolve(handle: string, cwd: string): string | null {
    const wanted = handle.toLowerCase();
    const hits = [...this.byLine.values()]
      .filter((name) => name.name === wanted && cwdMatches(name, cwd))
      .sort((a, b) => b.ts - a.ts);
    return hits[0]?.line ?? null;
  }

  /**
   * Magic candidates for a typed first-token `prefix` in `cwd`: handles where
   * `prefix` is a case-insensitive prefix, shorter handle first, then newest.
   * `display` REPLACES the typed handle on accept — that is the resolution.
   */
  match(prefix: string, cwd: string): RankedCandidate[] {
    const wanted = prefix.toLowerCase();
    return [...this.byLine.values()]
      .filter((name) => name.name.startsWith(wanted) && cwdMatches(name, cwd))
      .sort((a, b) => a.name.length - b.name.length || b.ts - a.ts)
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
