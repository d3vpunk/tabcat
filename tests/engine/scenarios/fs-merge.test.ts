import { describe, expect, it } from 'vitest';
import { HOURS, PROJECT_A, fakeFs, predictor, repeat } from './helpers.js';

const CMD = (file: string) => `vendor/bin/tool --filter="module/${file}"`;

describe('Scenario: filesystem merge', () => {
  const history = [
    ...repeat(CMD('contractname.md'), 3, 2 * HOURS),
    ...repeat(CMD('other-contract.md'), 1, 5 * HOURS),
  ];

  const fs = fakeFs({
    [`${PROJECT_A}/module`]: [
      { name: 'contractname.md', isDir: false },
      { name: 'brandnew.md', isDir: false },
      { name: 'subdir', isDir: true },
    ],
  });

  it('never-typed but existing files appear in the dropdown', () => {
    const p = predictor(history, fs);
    const line = 'vendor/bin/tool --filter="module/';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    const brandnew = prediction.candidates.find((c) => c.display === 'brandnew.md');
    expect(brandnew).toBeDefined();
    expect(brandnew?.source).toBe('fs');
  });

  it('history candidates that also exist in the FS get source both and rank on top', () => {
    const p = predictor(history, fs);
    const line = 'vendor/bin/tool --filter="module/';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe('contractname.md"');
    expect(prediction.candidates[0]?.source).toBe('both');
  });

  it('directories are suggested with a trailing slash', () => {
    const p = predictor(history, fs);
    const line = 'vendor/bin/tool --filter="module/su';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    const subdir = prediction.candidates.find((c) => c.display === 'subdir/');
    expect(subdir).toBeDefined();
    expect(subdir?.insert).toBe('bdir/');
  });

  it('without a path-like token the FS is not queried (no dropdown flooding)', () => {
    const explodingFs = fakeFs({});
    const p = predictor(repeat('git status', 2, 1 * HOURS), explodingFs);
    const prediction = p.predict({ line: '', cursor: 0, cwd: PROJECT_A });

    expect(prediction.candidates.every((c) => c.source === 'history')).toBe(true);
  });
});
