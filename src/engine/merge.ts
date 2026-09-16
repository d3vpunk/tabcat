import { ChunkModel, Continuation, END, isInformative } from './model.js';

export interface MergeConfig {
  /** Share of probability mass the top follow-up chunk must carry. */
  threshold: number;
  /** Upper bound on chunks per merged Tab step (runaway protection). */
  maxChunks: number;
}

export const DEFAULT_MERGE: MergeConfig = {
  threshold: 0.9,
  maxChunks: 64,
};

/**
 * Variability-aware merging (anti-footgun rule):
 * Starting from the candidate, look ahead along the prediction and merge
 * as long as the branching factor is ≈ 1. At the first real branch
 * (or when the line usually ends there) the merge stops — Tab never
 * overshoots into the variable part.
 */
export function mergeForward(
  model: ChunkModel,
  context: readonly string[],
  candidate: string,
  cwd: string,
  now: number,
  config: MergeConfig = DEFAULT_MERGE,
): string {
  return mergeChunks(model, context, candidate, cwd, now, config).join('');
}

/** `mergeForward` as the chunk sequence it is built from. */
function mergeChunks(
  model: ChunkModel,
  context: readonly string[],
  candidate: string,
  cwd: string,
  now: number,
  config: MergeConfig,
): string[] {
  const merged: string[] = [candidate];
  const ctx: string[] = [...context, candidate];

  while (merged.length < config.maxChunks) {
    const continuations = model.longestContinuations(ctx, cwd, now);
    if (continuations.length === 0) break;

    const top = continuations[0];
    if (!top || top.text === END) break;

    const total = continuations.reduce((sum, c) => sum + c.score, 0);
    if (total <= 0 || top.score / total < config.threshold) break;

    merged.push(top.text);
    ctx.push(top.text);
  }

  return merged;
}

export interface Branch {
  text: string;
  score: number;
}

export interface Fork {
  /** Every way the line goes on from here, merged forward, strongest first. */
  branches: Branch[];
  /** Share of the fork's mass on the line simply ending here; 0 when it never does. */
  endShare: number;
}

/**
 * How many pure-separator levels a branch is followed through before it is
 * accepted without a word: `cd projects` → `/` → `radio` is one level.
 */
const MAX_SEPARATOR_DEPTH = 3;

/**
 * The fork right behind `context`: its continuations from exactly that
 * context, each merged forward. Pure separators are walked through so a
 * branch always carries a real word — `cd projects` forks into `/radio` and
 * `/tabby`, not into a lone `/`. END is not a branch: Tab means "more", the
 * line ending is what Enter is for — its share is reported instead, so the
 * caller can keep quiet where the line usually ends.
 *
 * The exact context, never a shorter one: a context the model has not seen
 * has no fork, and back-off would lend the branches of an unrelated command.
 * `limit` bounds how many continuations are merged per level, like `topN`
 * bounds the ranking.
 */
export function forkBranches(
  model: ChunkModel,
  context: readonly string[],
  cwd: string,
  now: number,
  config: MergeConfig = DEFAULT_MERGE,
  limit: number = Number.POSITIVE_INFINITY,
): Fork {
  const continuations = model.exactContinuations(context, cwd, now);
  const total = continuations.reduce((sum, c) => sum + c.score, 0);
  const end = continuations.find((c) => c.text === END);
  const endShare = end !== undefined && total > 0 ? end.score / total : 0;
  const branches = expandFork(model, context, continuations, cwd, now, config, limit, 0);
  return { branches: branches.sort((a, b) => b.score - a.score), endShare };
}

function expandFork(
  model: ChunkModel,
  context: readonly string[],
  continuations: readonly Continuation[],
  cwd: string,
  now: number,
  config: MergeConfig,
  limit: number,
  depth: number,
): Branch[] {
  const branches: Branch[] = [];
  // exactContinuations is sorted strongest first, so the slice keeps the top.
  for (const continuation of continuations.filter((c) => c.text !== END).slice(0, limit)) {
    const chunks = mergeChunks(model, context, continuation.text, cwd, now, config);
    const text = chunks.join('');
    if (depth < MAX_SEPARATOR_DEPTH && !chunks.some(isInformative)) {
      const deeperContext = [...context, ...chunks];
      const deeper = expandFork(
        model,
        deeperContext,
        model.exactContinuations(deeperContext, cwd, now),
        cwd,
        now,
        config,
        limit,
        depth + 1,
      );
      if (deeper.length === 0) branches.push({ text, score: continuation.score });
      for (const branch of deeper) branches.push({ text: text + branch.text, score: branch.score });
      continue;
    }
    branches.push({ text, score: continuation.score });
  }
  return branches;
}
