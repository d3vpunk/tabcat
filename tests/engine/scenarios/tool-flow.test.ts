import { describe, expect, it } from 'vitest';
import { DAYS, HOURS, PROJECT_A, entry, predictor, repeat, tabChain } from './helpers.js';

const CMD = (file: string) => `vendor/bin/tool --filter="module/${file}"`;

describe('Scenario: tool flow (canonical example)', () => {
  // Two different files in the history -> real branch point at the filename.
  const history = [
    ...repeat(CMD('contractname.md'), 3, 2 * HOURS),
    ...repeat(CMD('other-contract.md'), 1, 5 * HOURS),
  ];

  it('tab takes you to the branch point (module/) in one step, never beyond', () => {
    const p = predictor(history);
    const prediction = p.predict({ line: '', cursor: 0, cwd: PROJECT_A });
    const top = prediction.candidates[0];

    expect(top?.insert).toBe('vendor/bin/tool --filter="module/');
  });

  it('at the branch point the dropdown shows the filenames, most frequent preselected', () => {
    const p = predictor(history);
    const line = 'vendor/bin/tool --filter="module/';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    const inserts = prediction.candidates.map((c) => c.insert);
    expect(inserts[0]).toBe('contractname.md"');
    expect(inserts).toContain('other-contract.md"');
  });

  it('the complete tab chain reconstructs the command', () => {
    const p = predictor(history);
    const steps = tabChain(p, PROJECT_A);
    expect(steps.join('')).toBe(CMD('contractname.md'));
  });

  it('typed prefix at the start: "v" suggests the tool chain', () => {
    const p = predictor(history);
    const prediction = p.predict({ line: 'v', cursor: 1, cwd: PROJECT_A });
    const top = prediction.candidates[0];

    expect(prediction.prefix).toBe('v');
    expect(top?.display.startsWith('vendor')).toBe(true);
    // insert no longer contains the typed "v"
    expect(top?.insert.startsWith('endor')).toBe(true);
  });
});

describe('Scenario: merge limits', () => {
  it('never merges beyond a real branch point (docker compose vs run)', () => {
    const history = [
      ...repeat('docker compose up', 3, 3 * HOURS),
      ...repeat('docker run -it ubuntu bash', 3, 3 * HOURS),
    ];
    const p = predictor(history);
    const prediction = p.predict({ line: '', cursor: 0, cwd: PROJECT_A });
    const top = prediction.candidates[0];

    // After 'docker ' it branches 50/50 -> tab stops exactly there.
    expect(top?.insert).toBe('docker ');
  });

  it('single historical continuation gets fully merged', () => {
    const history = repeat('git status', 5, 1 * HOURS);
    const p = predictor(history);
    const prediction = p.predict({ line: '', cursor: 0, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe('git status');
  });
});
