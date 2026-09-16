import { describe, expect, it } from 'vitest';
import { HOURS, PROJECT_A, predictor, repeat, tabChain } from './helpers.js';

/**
 * A fully typed word right before a fork used to leave Tab with nothing to
 * insert: `cd projects` knew `/radio` and `/tabby` but offered only `projects`
 * itself. The fork's branches are the dropdown there.
 */
describe('Scenario: fork branches after a completed word', () => {
  const history = [
    ...repeat('cd projects/radio', 3, 2 * HOURS),
    ...repeat('cd projects/tabby', 1, 5 * HOURS),
    ...repeat('cd projects', 2, 3 * HOURS),
  ];

  it('offers the branches of the fork, most frecent first', () => {
    const p = predictor(history);
    const line = 'cd projects';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    const inserts = prediction.candidates.map((c) => c.insert);
    expect(inserts[0]).toBe('/radio');
    expect(inserts).toContain('/tabby');
    expect(prediction.candidates[0]?.display).toBe('projects/radio');
  });

  it('never offers an empty insert once branches exist', () => {
    const p = predictor(history);
    const line = 'cd projects';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates.every((c) => c.insert !== '')).toBe(true);
  });

  it('walks through a space to the next real word', () => {
    const p = predictor([
      ...repeat('claude --skip', 3, 1 * HOURS),
      ...repeat('claude --skip --model haiku', 1, 2 * HOURS),
    ]);
    const line = 'claude --skip';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe(' --model haiku');
  });

  it('a word the line always ends on keeps its plain candidate', () => {
    const p = predictor(repeat('git status', 5, 1 * HOURS));
    const line = 'git status';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates).toHaveLength(1);
    expect(prediction.candidates[0]?.display).toBe('status');
    expect(prediction.candidates[0]?.insert).toBe('');
  });

  it('the tab chain crosses the fork instead of stopping dead', () => {
    const p = predictor(history);
    expect(tabChain(p, PROJECT_A).join('')).toBe('cd projects/radio');
  });

  it('a case-corrected word expands from its learned spelling', () => {
    const p = predictor([...repeat('cd Projects/radio', 3, 2 * HOURS), ...repeat('cd Projects', 2, 3 * HOURS)]);
    const line = 'cd projects';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('Projects/radio');
    expect(prediction.candidates[0]?.insert).toBe('/radio');
  });

  it('a shorter context never lends its branches to the fork', () => {
    // `projects` alone was seen after `ls`; that fork belongs to `ls`, not to `cd`.
    const p = predictor([
      ...repeat('cd Projects/radio', 3, 2 * HOURS),
      ...repeat('cd Projects', 2, 3 * HOURS),
      ...repeat('ls projects/junk', 1, 40 * HOURS),
    ]);
    const line = 'cd projects';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('Projects/radio');
    expect(prediction.candidates.some((c) => c.display.includes('junk'))).toBe(false);
  });

  it('where the line usually ends, the plain word stays first and the branches follow', () => {
    const p = predictor([...repeat('git status', 20, 1 * HOURS), ...repeat('git status --short', 1, 30 * HOURS)]);
    const line = 'git status';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('status');
    expect(prediction.candidates[0]?.insert).toBe('');
    expect(prediction.candidates[1]?.insert).toBe(' --short');
  });

  it('a lone separator is a branch when nothing follows it', () => {
    const p = predictor([...repeat('cd auto', 5, 1 * HOURS), ...repeat('cd auto/', 1, 2 * HOURS)]);
    const line = 'cd auto';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe('/');
  });

  it('a partially typed word is still plain prefix completion', () => {
    const p = predictor(history);
    const line = 'cd proj';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe('ects');
  });
});
