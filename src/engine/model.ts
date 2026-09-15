import { lex } from './lexer.js';

export interface Occurrence {
  ts: number; // epoch millis
  cwd: string | null;
}

export interface HistoryEntry {
  ts: number;
  /** null = imported shell history without reliable directory context. */
  cwd: string | null;
  line: string;
  exitCode?: number;
  /** Only for input captured in the tabcat REPL; imported/old entries have no telemetry. */
  completion?: CompletionTelemetry;
}

export interface CompletionTelemetry {
  attempts: number;
  accepts: number;
  top1Accepts: number;
  acceptedChars: number;
  undos: number;
  durationMs: number;
}

export interface ScoringConfig {
  halfLifeDays: number;
  shortHalfLifeHours: number;
  shortWeight: number;
  cwdBoost: number;
  backoffPenalty: number;
  maxContext: number;
  /** Lower bound of the long-term term: old frequency never decays to exactly 0. */
  frequencyFloor: number;
  /**
   * Keep only the most recent N occurrences per edge. Without the cap,
   * scoring grows linearly with total history — predict() runs per keystroke.
   */
  maxOccurrencesPerEdge: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  halfLifeDays: 7,
  shortHalfLifeHours: 4,
  shortWeight: 8,
  cwdBoost: 3,
  backoffPenalty: 0.3,
  maxContext: 16,
  frequencyFloor: 0.02,
  maxOccurrencesPerEdge: 64,
};

/**
 * The time half of frecency: long-term decay plus a heavily weighted short-term
 * term, without the cwd boost. Shared with the daemon's cwd index, which ranks
 * directories by the same curve and has no directory to compare against.
 */
export function frecency(ts: number, now: number, config: ScoringConfig): number {
  const ageMs = now - ts;
  // Dated far in the future (broken clock during import): do not reward with
  // maximal score — the entry would otherwise dominate for years.
  if (ageMs < -MS_PER_DAY) return 0;
  const ageDays = Math.max(0, ageMs) / MS_PER_DAY;
  const ageHours = Math.max(0, ageMs) / MS_PER_HOUR;
  const longTerm = Math.max(Math.pow(0.5, ageDays / config.halfLifeDays), config.frequencyFloor);
  const shortTerm = config.shortWeight * Math.pow(0.5, ageHours / config.shortHalfLifeHours);
  return longTerm + shortTerm;
}

/** Sentinel for "line ends here" — never emitted as a suggestion. */
export const END = '\u0000END';

/** Sentinel for line start. */
export const BEGIN = "\u0000BEGIN";

const KEY_SEP = '\u0001';

export interface Continuation {
  text: string;
  score: number;
  /** 0 = longest matching context; higher = shorter backoff context. */
  level: number;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** Does the chunk contain at least one word character? (separators/spaces: no) */
export const isInformative = (chunkText: string): boolean => /[\p{L}\p{N}]/u.test(chunkText);

/**
 * Variable n-grams over chunk sequences: each edge (context -> next chunk)
 * collects occurrences with timestamp + cwd for frecency scoring.
 */
export class ChunkModel {
  private readonly edges = new Map<string, Map<string, Occurrence[]>>();

  constructor(private readonly config: ScoringConfig = DEFAULT_SCORING) {}

  learn(entry: HistoryEntry): void {
    const texts = lex(entry.line).map((c) => c.text);
    if (texts.length === 0) return;
    const seq = [BEGIN, ...texts, END];
    const occ: Occurrence = { ts: entry.ts, cwd: entry.cwd };

    // The empty context (k=0) is deliberately NOT learned: it would collect
    // every chunk at every position and add noise to ranking and merge threshold.
    for (let i = 1; i < seq.length; i++) {
      const next = seq[i] as string;
      const maxK = Math.min(i, this.config.maxContext);
      for (let k = 1; k <= maxK; k++) {
        const key = seq.slice(i - k, i).join(KEY_SEP);
        let byNext = this.edges.get(key);
        if (!byNext) {
          byNext = new Map();
          this.edges.set(key, byNext);
        }
        let occs = byNext.get(next);
        if (!occs) {
          occs = [];
          byNext.set(next, occs);
        }
        occs.push(occ);
        if (occs.length > this.config.maxOccurrencesPerEdge) occs.shift();
      }
    }
  }

  /**
   * Candidates for the next chunk after `context` (chunk texts left of the cursor).
   * Backoff: candidates from longer contexts dominate STRUCTURALLY
   * (level-major ranking) — shorter contexts only backfill. Score penalties
   * alone are not enough: the [' '] context carries so much mass that it would
   * otherwise outvote real but old continuations. END is included.
   */
  continuations(context: readonly string[], cwd: string, now: number): Continuation[] {
    if (context.length === 0) return [];
    const best = new Map<string, { score: number; level: number }>();
    let level = 0;

    for (let k = Math.min(context.length, this.config.maxContext); k >= 1; k--) {
      const slice = context.slice(context.length - k);
      // Backoff contexts without any word character ([' '], ['/'], ['"']) carry
      // no information — they would only flush noise into the lower slots.
      if (level > 0 && !slice.some(isInformative)) continue;
      const key = slice.join(KEY_SEP);
      const byNext = this.edges.get(key);
      if (!byNext || byNext.size === 0) continue;

      const penalty = Math.pow(this.config.backoffPenalty, level);
      for (const [text, occs] of byNext) {
        if (best.has(text)) continue; // longest context already won
        let score = 0;
        for (const o of occs) score += this.occurrenceScore(o, cwd, now);
        best.set(text, { score: score * penalty, level });
      }
      level++;
    }

    return [...best.entries()]
      .map(([text, { score, level: l }]) => ({ text, score, level: l }))
      .sort((a, b) => (a.level !== b.level ? a.level - b.level : b.score - a.score));
  }

  /**
   * Distribution from ONLY the longest matching context — no backoff noise.
   * Basis for the merge decision (branching factor).
   */
  longestContinuations(context: readonly string[], cwd: string, now: number): Continuation[] {
    for (let k = Math.min(context.length, this.config.maxContext); k >= 1; k--) {
      const key = context.slice(context.length - k).join(KEY_SEP);
      const byNext = this.edges.get(key);
      if (!byNext || byNext.size === 0) continue;

      return [...byNext.entries()]
        .map(([text, occs]) => ({
          text,
          score: occs.reduce((sum, o) => sum + this.occurrenceScore(o, cwd, now), 0),
          level: 0,
        }))
        .sort((a, b) => b.score - a.score);
    }
    return [];
  }

  /** Frecency: long-term decay + heavily weighted short-term decay, cwd boost. */
  private occurrenceScore(o: Occurrence, cwd: string, now: number): number {
    const boost = o.cwd !== null && o.cwd === cwd ? this.config.cwdBoost : 1;
    return frecency(o.ts, now, this.config) * boost;
  }
}
