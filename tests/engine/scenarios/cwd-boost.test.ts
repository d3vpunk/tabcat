import { describe, expect, it } from 'vitest';
import { HOURS, PROJECT_A, PROJECT_B, predictor, repeat } from './helpers.js';

describe('Scenario: cwd as ranking signal', () => {
  const history = [
    ...repeat('make deploy', 2, 2 * HOURS, PROJECT_A),
    ...repeat('npm test', 2, 2 * HOURS, PROJECT_B),
  ];

  it('in project A the command learned there ranks on top', () => {
    const p = predictor(history);
    const prediction = p.predict({ line: '', cursor: 0, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe('make deploy');
    // the foreign command stays reachable, just lower ranked
    expect(prediction.candidates.map((c) => c.insert)).toContain('npm test');
  });

  it('in project B the ranking is reversed', () => {
    const p = predictor(history);
    const prediction = p.predict({ line: '', cursor: 0, cwd: PROJECT_B });

    expect(prediction.candidates[0]?.insert).toBe('npm test');
  });
});

describe('Imported history without cwd', () => {
  it('gets no artificial cwd boost in any project', () => {
    const imported = [{ ts: Date.now() - HOURS, cwd: null, line: 'neutral command' }];
    const p = predictor(imported);

    const inA = p.predict({ line: '', cursor: 0, cwd: PROJECT_A }).candidates[0];
    const inB = p.predict({ line: '', cursor: 0, cwd: PROJECT_B }).candidates[0];

    expect(inA?.score).toBe(inB?.score);
  });
});

describe('Scenario: do not learn typos', () => {
  it('exit 127/126 does not flow into the model, exit 1 (red test) does', () => {
    const p = predictor([
      { ...repeat('gti status', 3, 1)[0]!, exitCode: 127 },
      { ...repeat('vendor/bin/tool', 1, 1)[0]!, exitCode: 1 },
    ]);
    const prediction = p.predict({ line: '', cursor: 0, cwd: PROJECT_A });
    const inserts = prediction.candidates.map((c) => c.insert);

    expect(inserts).not.toContain('gti status');
    expect(inserts).toContain('vendor/bin/tool');
  });
});
