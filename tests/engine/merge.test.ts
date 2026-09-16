import { describe, expect, it } from 'vitest';
import { BEGIN, ChunkModel } from '../../src/engine/model.js';
import { forkBranches } from '../../src/engine/merge.js';
import { HOURS, NOW, PROJECT_A, repeat } from './scenarios/helpers.js';

const modelOf = (lines: { line: string; times: number }[]): ChunkModel => {
  const model = new ChunkModel();
  for (const { line, times } of lines) for (const entry of repeat(line, times, 1 * HOURS)) model.learn(entry);
  return model;
};

describe('forkBranches', () => {
  it('lists the fork after the context, most frecent first, never the line ending', () => {
    const model = modelOf([
      { line: 'cd projects/radio', times: 3 },
      { line: 'cd projects/tabby', times: 1 },
      { line: 'cd projects', times: 2 },
    ]);
    const fork = forkBranches(model, [BEGIN, 'cd', ' ', 'projects'], PROJECT_A, NOW);

    expect(fork.branches.map((b) => b.text)).toEqual(['/radio', '/tabby']);
    expect(fork.branches[0]!.score).toBeGreaterThan(fork.branches[1]!.score);
  });

  it('reports how much of the fork is the line simply ending', () => {
    const model = modelOf([{ line: 'git status', times: 3 }, { line: 'git status --short', times: 1 }]);
    const fork = forkBranches(model, [BEGIN, 'git', ' ', 'status'], PROJECT_A, NOW);

    // Three endings against one continuation; frecency spreads the four
    // occurrences a little, so the share sits near, not at, three quarters.
    expect(fork.endShare).toBeGreaterThan(0.7);
    expect(fork.endShare).toBeLessThan(0.8);
    expect(fork.branches.map((b) => b.text)).toEqual([' --short']);
  });

  it('a context the model never saw has no fork', () => {
    const model = modelOf([{ line: 'cd projects/radio', times: 3 }]);
    const fork = forkBranches(model, [BEGIN, 'cd', ' ', 'Projects'], PROJECT_A, NOW);

    expect(fork.branches).toEqual([]);
    expect(fork.endShare).toBe(0);
  });

  it('merges only the strongest `limit` continuations', () => {
    const model = modelOf(Array.from({ length: 5 }, (_, i) => ({ line: `ls dir${i}`, times: 5 - i })));
    const fork = forkBranches(model, [BEGIN, 'ls'], PROJECT_A, NOW, undefined, 2);

    expect(fork.branches.map((b) => b.text)).toEqual([' dir0', ' dir1']);
  });
});
