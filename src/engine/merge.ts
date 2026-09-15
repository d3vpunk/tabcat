import { ChunkModel, END, isInformative } from './model.js';

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

/**
 * How many pure-separator levels a branch is followed through before it is
 * accepted without a word: `cd projects` → `/` → `radio` is one level.
 */
const MAX_SEPARATOR_DEPTH = 3;

/**
 * The branches of the fork a merge stopped at: every continuation of
 * `context` from the longest matching context, each merged forward. Pure
 * separators are walked through so a branch always carries a real word —
 * `cd projects` forks into `/radio` and `/tabby`, not into a lone `/`.
 * END is not a branch: Tab means "more", the line ending is what Enter is for.
 */
export function forkBranches(
  model: ChunkModel,
  context: readonly string[],
  cwd: string,
  now: number,
  config: MergeConfig = DEFAULT_MERGE,
): Branch[] {
  return expandFork(model, context, cwd, now, config, 0).sort((a, b) => b.score - a.score);
}

function expandFork(
  model: ChunkModel,
  context: readonly string[],
  cwd: string,
  now: number,
  config: MergeConfig,
  depth: number,
): Branch[] {
  const branches: Branch[] = [];
  for (const continuation of model.longestContinuations(context, cwd, now)) {
    if (continuation.text === END) continue;
    const chunks = mergeChunks(model, context, continuation.text, cwd, now, config);
    const text = chunks.join('');
    if (depth < MAX_SEPARATOR_DEPTH && !chunks.some(isInformative)) {
      const deeper = expandFork(model, [...context, ...chunks], cwd, now, config, depth + 1);
      if (deeper.length === 0) branches.push({ text, score: continuation.score });
      for (const branch of deeper) branches.push({ text: text + branch.text, score: branch.score });
      continue;
    }
    branches.push({ text, score: continuation.score });
  }
  return branches;
}
