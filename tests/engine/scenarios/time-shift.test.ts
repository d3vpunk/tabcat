import { describe, expect, it } from 'vitest';
import { DAYS, HOURS, PROJECT_A, predictor, repeat } from './helpers.js';

const CMD = (file: string) => `vendor/bin/tool --filter="module/${file}"`;

describe('Scenario: time shift (today I work on X)', () => {
  // Yesterday 10x the old file, today only 2x the new one.
  const history = [
    ...repeat(CMD('contractname.md'), 10, 1 * DAYS),
    ...repeat(CMD('contractname2.md'), 2, 1 * HOURS),
  ];

  it('today contractname2.md is preselected, the old one stays reachable in 2nd place', () => {
    const p = predictor(history);
    const line = 'vendor/bin/tool --filter="module/';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe('contractname2.md"');
    expect(prediction.candidates[1]?.insert).toBe('contractname.md"');
  });

  it('the merge still stops at the branch point despite recency dominance', () => {
    const p = predictor(history);
    const prediction = p.predict({ line: '', cursor: 0, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe('vendor/bin/tool --filter="module/');
  });

  it('prefix filter: typed "con" keeps both contractname candidates in recency order', () => {
    const p = predictor(history);
    const line = 'vendor/bin/tool --filter="module/con';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.prefix).toBe('con');
    expect(prediction.candidates[0]?.display).toBe('contractname2.md"');
    // insert no longer contains the typed prefix
    expect(prediction.candidates[0]?.insert).toBe('tractname2.md"');
  });

  it('stale level-0 candidate (frequencyFloor) does not dominate fresh backoff', () => {
    const p = predictor([
      ...repeat('make deploy', 1, 60 * DAYS), // ancient, one-off -> floor score
      ...repeat('run make test', 5, 1 * HOURS), // fresh, but only reachable via shorter context
    ]);
    const line = 'make ';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    // Without demotion, 'deploy' (longest context, score 0.06) would
    // structurally rank above 'test' (backoff, score ~40).
    expect(prediction.candidates[0]?.insert).toBe('test');
    expect(prediction.candidates[1]?.insert).toBe('deploy');

    // With a typed prefix, the old command remains findable deliberately.
    const typed = p.predict({ line: 'make d', cursor: 6, cwd: PROJECT_A });
    expect(typed.candidates[0]?.display).toBe('deploy');
  });
});
