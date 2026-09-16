import { Chunk, lex } from './lexer.js';
import { BEGIN, ChunkModel, DEFAULT_SCORING, END, HistoryEntry, ScoringConfig } from './model.js';
import { DEFAULT_MERGE, MergeConfig, forkBranches, mergeForward } from './merge.js';
import { completePathToken, directoryExists, FsLike } from './fs-completer.js';
import { cdTarget, escapeFsText, quoteContext, shellPathToken } from './shell-syntax.js';
import type { NameIndex } from './names.js';

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
  source: 'history' | 'fs' | 'both' | 'magic';
  /** Set for magic candidates: the user-assigned handle that resolves to `display`. */
  magicName?: string;
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

/**
 * The line as it reads after accepting `candidate`: `replacePrefixLength`
 * (or the filter prefix) characters left of the cursor are replaced by
 * `display`. The one accept rule — the REPL applies it, the daemon badges by
 * it, and a ranking step that judges a candidate by its outcome asks it.
 */
export function acceptedLine(line: string, cursor: number, candidate: RankedCandidate, prefixLength: number): string {
  const replaceFrom = Math.max(0, cursor - (candidate.replacePrefixLength ?? prefixLength));
  return line.slice(0, replaceFrom) + candidate.display + line.slice(cursor);
}

/** What every ranking step knows about the line being typed. */
interface Scope {
  /** The line left of the cursor. */
  readonly left: string;
  readonly chunks: readonly Chunk[];
  /** The word at the cursor, possibly incomplete — the filter prefix. */
  readonly prefix: string;
  /** BEGIN plus every chunk before the prefix — the model context. */
  readonly context: readonly string[];
  readonly cwd: string;
  readonly now: number;
}

export class Predictor {
  private model: ChunkModel;

  constructor(
    entries: readonly HistoryEntry[],
    private readonly opts: { now: () => number; fs?: FsLike; homeDir?: string; names?: NameIndex },
    private readonly config: PredictorConfig = DEFAULT_PREDICTOR,
  ) {
    this.model = new ChunkModel(config.scoring);
    for (const entry of entries) this.learn(entry);
  }

  learn(entry: HistoryEntry): void {
    if (!isLearnable(entry)) return;
    this.model.learn(entry);
  }

  /**
   * Relearns from scratch. The only way to unlearn: occurrences carry no
   * back-reference to their entry, and `maxOccurrencesPerEdge` has already
   * discarded what a surgical removal would need to restore. Costs the same
   * O(entries) as startup and forgetting is rare — a keystroke never pays this.
   */
  rebuild(entries: readonly HistoryEntry[]): void {
    this.model = new ChunkModel(this.config.scoring);
    for (const entry of entries) this.learn(entry);
  }

  /**
   * A pipeline: the ranked list from history and filesystem, then one step per
   * rule that reshapes it, each with its reasoning on its own doc block. A
   * future per-command rule (`ls`, `git checkout`) is one more step here, not
   * one more branch inside the ranking.
   */
  predict(input: PredictInput): Prediction {
    const scope = this.scopeOf(input);
    let candidates = this.rankHistoryAndFs(scope);
    candidates = this.expandDeadFork(candidates, scope);
    candidates = this.preferReachableCdTargets(candidates, scope);
    candidates = this.prependMagic(candidates, scope);
    return { candidates: candidates.slice(0, this.config.topN), prefix: scope.prefix };
  }

  private scopeOf(input: PredictInput): Scope {
    const left = input.line.slice(0, input.cursor);
    const chunks = lex(left);
    // A word directly at the cursor is potentially incomplete -> filter prefix.
    const last = chunks.at(-1);
    const prefix = last && last.kind === 'word' ? last.text : '';
    const context = [BEGIN, ...(prefix !== '' ? chunks.slice(0, -1) : chunks).map((c) => c.text)];
    return { left, chunks, prefix, context, cwd: input.cwd, now: this.opts.now() };
  }

  /**
   * History continuations of the context, filtered by the typed prefix and
   * ranked level-major (longest matching context first, back-off only fills
   * gaps), enriched with filesystem completion where a path is being typed.
   */
  private rankHistoryAndFs(scope: Scope): RankedCandidate[] {
    const { left, chunks, prefix, context, cwd, now } = scope;
    const byText = new Map<
      string,
      { score: number; level: number; source: RankedCandidate['source']; isDir: boolean }
    >();

    // Does the line usually end here according to the longest context? Then
    // only the siblings from exactly that context are real alternatives (e.g. a
    // rarely used flag) — backoff backfill (level > 0) would be noise that
    // keeps sticking on endlessly. Only relevant without a typed prefix -> lazy.
    const lineLikelyComplete = prefix === '' && this.model.longestContinuations(context, cwd, now)[0]?.text === END;
    const prefixLower = prefix.toLowerCase();
    const { token: fsToken, prefix: fsPrefix, rawPrefixLength } = shellPathToken(left);

    for (const c of this.model.continuations(context, cwd, now)) {
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
        for (const fsCandidate of completePathToken(fsToken, cwd, this.opts.fs, this.opts.homeDir)) {
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
    const quote = quoteContext(left);
    const acceptedPrefixLength = escapeFsText(fsPrefix, quote).length;
    return [...byText.entries()]
      .sort((a, b) => {
        const levelA = effectiveLevel(a[1]);
        const levelB = effectiveLevel(b[1]);
        return levelA !== levelB ? levelA - levelB : b[1].score - a[1].score;
      })
      .slice(0, this.config.topN)
      .map(([text, meta]) => {
        const raw = text + (meta.isDir ? '/' : '');
        const merged =
          meta.source === 'fs' ? escapeFsText(raw, quote) : mergeForward(this.model, context, text, cwd, now, this.config.merge);
        return {
          insert: meta.source === 'fs' ? merged.slice(acceptedPrefixLength) : merged.slice(prefix.length),
          display: merged,
          score: meta.score,
          source: meta.source,
          ...(meta.source === 'fs' ? { acceptedPrefixLength, replacePrefixLength: rawPrefixLength } : {}),
        };
      });
  }

  /**
   * A fully typed word right before a fork: the merge stopped at once, the top
   * candidate has nothing left to insert and Tab would be a dead key. The
   * fork's branches are what belongs in the dropdown there — `cd projects`
   * offers `/radio` and `/tabby`, not `projects` again. They outrank sibling
   * prefix completions: the user typed this word to the end, the fork is the
   * menu. The fork is read behind the candidate's own spelling, so a
   * case-corrected `Projects` expands as well.
   *
   * Where the line usually ends (END carries at least the merge threshold)
   * the plain word stays first, so the ghost stays quiet, and the branches
   * follow in the dropdown — the same calm `mergeForward` keeps there.
   */
  private expandDeadFork(candidates: RankedCandidate[], scope: Scope): RankedCandidate[] {
    const dead = candidates[0];
    // An fs candidate replaces a shell-escaped token; its spelling is no chunk
    // the model knows, so there is no fork to read behind it.
    if (dead === undefined || dead.insert !== '' || dead.source === 'fs') return candidates;
    const fork = forkBranches(
      this.model,
      [...scope.context, dead.display],
      scope.cwd,
      scope.now,
      this.config.merge,
      this.config.topN,
    );
    if (fork.branches.length === 0) return candidates;
    const expanded: RankedCandidate[] = fork.branches.map((branch) => ({
      insert: branch.text,
      display: dead.display + branch.text,
      score: branch.score,
      source: 'history',
    }));
    const rest = candidates.filter((c) => c.insert !== '');
    return fork.endShare >= this.config.merge.threshold ? [dead, ...expanded, ...rest] : [...expanded, ...rest];
  }

  /**
   * `cd` goes somewhere. A directory learned at home (`projects`) is the wrong
   * answer inside a project however frecent it is. Candidates whose directory
   * exists from here rank first; the rest is demoted, never dropped — the
   * volume may simply be unmounted right now. Judged on the line as it would
   * read after the accept, so `cdk deploy` is not a cd and `git pull && cd src`
   * is one. One filesystem question per candidate, none without a filesystem.
   */
  private preferReachableCdTargets(candidates: RankedCandidate[], scope: Scope): RankedCandidate[] {
    const fs = this.opts.fs;
    if (fs === undefined) return candidates;
    const reachable = (candidate: RankedCandidate): boolean => {
      if (candidate.source === 'fs') return true; // exists by construction
      const target = cdTarget(acceptedLine(scope.left, scope.left.length, candidate, scope.prefix.length));
      return target === null || directoryExists(target, scope.cwd, fs, this.opts.homeDir);
    };
    return partition(candidates, reachable);
  }

  /**
   * Magic handles only compete on the first token: the handle stands in for a
   * whole command, so mid-line it can never be what the user means. They rank
   * above every frecency candidate — the user asked for them by name.
   */
  private prependMagic(candidates: RankedCandidate[], scope: Scope): RankedCandidate[] {
    if (this.opts.names === undefined || scope.context.length !== 1 || scope.prefix === '') return candidates;
    const magic = this.opts.names.match(scope.prefix, scope.cwd);
    return magic.length > 0 ? [...magic, ...candidates] : candidates;
  }
}

/** Stable split: every item `keep` accepts, in order, then every other item, in order. */
function partition<T>(items: readonly T[], keep: (item: T) => boolean): T[] {
  const kept: T[] = [];
  const rest: T[] = [];
  for (const item of items) (keep(item) ? kept : rest).push(item);
  return [...kept, ...rest];
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
