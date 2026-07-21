import { Chunk, lex } from './lexer.js';
import { BEGIN, ChunkModel, DEFAULT_SCORING, END, HistoryEntry, ScoringConfig } from './model.js';
import { DEFAULT_MERGE, MergeConfig, mergeForward } from './merge.js';
import { completePathToken, FsLike } from './fs-completer.js';

export interface RankedCandidate {
  /** What Tab/selection inserts into the line (merged, without already-typed text). */
  insert: string;
  /**
   * Display in the dropdown: complete candidate text (typed prefix + insert).
   * On accept, display REPLACES the typed prefix — this is how case-insensitive
   * matches correct the spelling ("doc" -> "Documents").
   */
  display: string;
  score: number;
  source: 'history' | 'fs' | 'both';
  /** Position in display after represented input prefix; differs when escaping adds characters. */
  acceptedPrefixLength?: number;
  /** Raw input length replaced on accept; differs for quoted or escaped path prefixes. */
  replacePrefixLength?: number;
}

export interface Prediction {
  /** Dropdown content, [0] = preselected. */
  candidates: RankedCandidate[];
  /** The already typed, incomplete token (filter prefix). */
  prefix: string;
}

export interface PredictorConfig {
  scoring: ScoringConfig;
  merge: MergeConfig;
  topN: number;
  /** Base score for pure filesystem candidates (files without history). */
  fsBaseScore: number;
  /**
   * Scores below this threshold count as stale (e.g. frequencyFloor
   * candidates from ancient contexts): without a typed prefix they rank
   * behind all fresh candidates — even behind backoff backfill.
   */
  staleThreshold: number;
}

export const DEFAULT_PREDICTOR: PredictorConfig = {
  scoring: DEFAULT_SCORING,
  merge: DEFAULT_MERGE,
  topN: 50,
  fsBaseScore: 0.5,
  staleThreshold: 0.25,
};

export interface PredictInput {
  line: string;
  cursor: number;
  cwd: string;
}

export class Predictor {
  private readonly model: ChunkModel;

  constructor(
    entries: readonly HistoryEntry[],
    private readonly opts: { now: () => number; fs?: FsLike; homeDir?: string },
    private readonly config: PredictorConfig = DEFAULT_PREDICTOR,
  ) {
    this.model = new ChunkModel(config.scoring);
    for (const entry of entries) this.learn(entry);
  }

  learn(entry: HistoryEntry): void {
    if (!isLearnable(entry)) return;
    this.model.learn(entry);
  }

  predict(input: PredictInput): Prediction {
    const now = this.opts.now();
    const left = input.line.slice(0, input.cursor);
    const chunks = lex(left);

    // A word directly at the cursor is potentially incomplete -> filter prefix.
    const last = chunks.at(-1);
    const prefix = last && last.kind === 'word' ? last.text : '';
    const context = [BEGIN, ...(prefix !== '' ? chunks.slice(0, -1) : chunks).map((c) => c.text)];

    const byText = new Map<
      string,
      { score: number; level: number; source: RankedCandidate['source']; isDir: boolean }
    >();

    // Does the line usually end here according to the longest context? Then
    // only the siblings from exactly that context are real alternatives (e.g. a
    // rarely used flag) — backoff backfill (level > 0) would be noise that
    // keeps sticking on endlessly. Only relevant without a typed prefix -> lazy.
    const lineLikelyComplete =
      prefix === '' && this.model.longestContinuations(context, input.cwd, now)[0]?.text === END;
    const prefixLower = prefix.toLowerCase();
    const { token: fsToken, prefix: fsPrefix, rawPrefixLength } = shellPathToken(left);

    for (const c of this.model.continuations(context, input.cwd, now)) {
      if (c.text === END) continue;
      if (lineLikelyComplete && c.level > 0) continue;
      if (!c.text.toLowerCase().startsWith(prefixLower)) continue;
      byText.set(c.text, { score: c.score, level: c.level, source: 'history', isDir: false });
    }

    if (this.opts.fs) {
      const { startIndex } = pathToken(chunks);
      // Bare words directly after a flag (-m, --name) are usually values,
      // not paths — suppress the FS flood there. Paths (with '/' or a
      // leading '.') are always completed, though.
      const looksPathy = fsToken.includes('/') || fsToken.startsWith('.');
      // Line complete according to the model (END tops the longest context)
      // and no sibling candidates -> byText is empty -> FS flood exactly where
      // lineLikelyComplete is supposed to create calm.
      const fsAllowed =
        looksPathy || (!lineLikelyComplete && !precededByFlag(chunks, startIndex) && byText.size === 0);
      if (fsAllowed) {
        for (const fsCandidate of completePathToken(fsToken, input.cwd, this.opts.fs, this.opts.homeDir)) {
          const name = fsCandidate.isDir ? fsCandidate.text.slice(0, -1) : fsCandidate.text;
          const existing = byText.get(name);
          if (existing) {
            // The score bump is deliberately symbolic (frecency scores are
            // orders of magnitude larger) — the real effect of FS
            // confirmation is level 0 + the "both" marker.
            existing.score += this.config.fsBaseScore;
            existing.source = 'both';
            existing.level = 0; // FS-confirmed -> same league as longest context
          } else {
            // FS hits are contextually exact -> same league as the longest context.
            byText.set(name, { score: this.config.fsBaseScore, level: 0, source: 'fs', isDir: fsCandidate.isDir });
          }
        }
      }
    }

    // Level-major: candidates from longer contexts rank structurally above
    // backoff backfill — score decides only within the same level.
    // Exception: stale candidates (score < staleThreshold) slip behind
    // everything fresh when no prefix is typed — the frequencyFloor should keep
    // old commands findable, not let them dominate forever.
    const effectiveLevel = (meta: { level: number; score: number }): number =>
      prefix === '' && meta.score < this.config.staleThreshold ? meta.level + 1000 : meta.level;
    const candidates: RankedCandidate[] = [...byText.entries()]
      .sort((a, b) => {
        const levelA = effectiveLevel(a[1]);
        const levelB = effectiveLevel(b[1]);
        return levelA !== levelB ? levelA - levelB : b[1].score - a[1].score;
      })
      .slice(0, this.config.topN)
      .map(([text, meta]) => {
        const raw = text + (meta.isDir ? '/' : '');
        const quote = quoteContext(left);
        const acceptedPrefixLength = escapeFsText(fsPrefix, quote).length;
        const merged =
          meta.source === 'fs'
            ? escapeFsText(raw, quote)
            : mergeForward(this.model, context, text, input.cwd, now, this.config.merge);
        return {
          insert: meta.source === 'fs' ? merged.slice(acceptedPrefixLength) : merged.slice(prefix.length),
          display: merged,
          score: meta.score,
          source: meta.source,
          ...(meta.source === 'fs'
            ? {
                acceptedPrefixLength,
                replacePrefixLength: rawPrefixLength,
              }
            : {}),
        };
      });

    return { candidates, prefix };
  }
}

type QuoteContext = 'single' | 'double' | null;

/** Escape only filesystem-derived text; learned shell syntax must stay intact. */
function escapeFsText(text: string, quote: QuoteContext): string {
  if (quote === 'single') return text.replaceAll("'", "'\\''");
  if (quote === 'double') return text.replace(/[\\"$`]/g, '\\$&');
  return text.replace(/[^A-Za-z0-9_@%+=:,./~-]/g, '\\$&');
}

/** Active shell quote immediately left of cursor, respecting backslash escapes. */
function quoteContext(line: string): QuoteContext {
  let quote: QuoteContext = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== 'single' && ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" && quote !== 'double') quote = quote === 'single' ? null : 'single';
    if (ch === '"' && quote !== 'single') quote = quote === 'double' ? null : 'double';
  }
  return quote;
}

/** Decode current shell argument for filesystem lookup while retaining raw replacement length. */
function shellPathToken(line: string): { token: string; prefix: string; rawPrefixLength: number } {
  let token = '';
  let quote: QuoteContext = null;
  let rawPrefixStart = line.length;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote !== 'single' && ch === '\\') {
      const escaped = line[i + 1];
      if (escaped !== undefined) {
        if (token === '') rawPrefixStart = i;
        token += escaped;
        i++;
      }
      continue;
    }
    if (ch === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      if (token === '') rawPrefixStart = i + 1;
      continue;
    }
    if (ch === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      if (token === '') rawPrefixStart = i + 1;
      continue;
    }
    if (quote === null && (/\s/.test(ch) || '|&;<>()='.includes(ch))) {
      token = '';
      rawPrefixStart = i + 1;
      continue;
    }
    if (token === '') rawPrefixStart = i;
    token += ch;
    if (ch === '/') rawPrefixStart = i + 1;
  }

  const slash = token.lastIndexOf('/');
  return { token, prefix: token.slice(slash + 1), rawPrefixLength: line.length - rawPrefixStart };
}

/**
 * Exit 127 (command not found) / 126 (not executable) are almost certainly
 * typos — learning from them would poison the prediction. Other
 * error codes are legitimate usage (red test run = exit 1, grep without
 * match = 1, Ctrl-C = 130) and are learned normally.
 */
function isLearnable(entry: HistoryEntry): boolean {
  return entry.exitCode !== 127 && entry.exitCode !== 126;
}

/**
 * Extracts the path-like token at the end of the line: walks backwards over
 * word chunks and '/' separators up to the next boundary (space, quote,
 * operator, '=', ...). startIndex = index of the first token chunk.
 */
function pathToken(chunks: readonly Chunk[]): { token: string; startIndex: number } {
  const parts: string[] = [];
  let i = chunks.length - 1;
  for (; i >= 0; i--) {
    const chunk = chunks[i];
    if (!chunk) break;
    const isPathPart = chunk.kind === 'word' || (chunk.kind === 'sep' && chunk.text === '/');
    if (!isPathPart) break;
    parts.unshift(chunk.text);
  }
  return { token: parts.join(''), startIndex: i + 1 };
}

/**
 * Is the token immediately after a flag (-m file, --name file)?
 * Then it is usually a value, not a path. Word chunks before it are
 * walked over as well ("-m" lexes as flag '-' + word 'm').
 */
function precededByFlag(chunks: readonly Chunk[], startIndex: number): boolean {
  let i = startIndex - 1;
  while (i >= 0 && chunks[i]?.kind === 'space') i--;
  while (i >= 0 && chunks[i]?.kind === 'word') i--;
  const chunk = chunks[i];
  // "--" (end-of-options) is not a flag with a value: paths come right
  // after it ("rm -- fil") — do not suppress FS completion.
  return chunk !== undefined && chunk.kind === 'flag' && chunk.text !== '--';
}
