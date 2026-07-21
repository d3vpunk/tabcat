import { ChunkModel, END } from './model.js';

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

  return merged.join('');
}
