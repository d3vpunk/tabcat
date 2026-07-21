import { describe, expect, it } from 'vitest';
import { HOURS, PROJECT_A, predictor, repeat } from './helpers.js';

describe('Scenario: context backoff', () => {
  const history = [
    ...repeat('docker compose up', 3, 2 * HOURS),
    ...repeat('docker run -it ubuntu bash', 1, 2 * HOURS),
    ...repeat('git status', 2, 2 * HOURS),
  ];

  it('after "docker " compose wins based on frecency', () => {
    const p = predictor(history);
    const prediction = p.predict({ line: 'docker ', cursor: 7, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe('compose up');
    expect(prediction.candidates.map((c) => c.display)).toContain('run -it ubuntu bash');
  });

  it('after "docker compose " only compose continuations dominate', () => {
    const p = predictor(history);
    const line = 'docker compose ';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.insert).toBe('up');
  });

  it('pure separator contexts ([" "]) do not flush noise into thin dropdowns', () => {
    const noisy = predictor([
      ...repeat('vendor/bin/tool --filter="x"', 2, 2 * HOURS),
      ...repeat('cd projects', 5, 1 * HOURS),
      ...repeat('open projects', 5, 1 * HOURS),
    ]);
    const line = 'vendor/bin/tool ';
    const prediction = noisy.predict({ line, cursor: line.length, cwd: PROJECT_A });

    // "projects" only follows the useless [' '] context -> suppressed
    expect(prediction.candidates.map((c) => c.display)).not.toContain('projects');
    expect(prediction.candidates[0]?.insert).toBe('--filter="x"');
  });

  it('unknown long context falls back sensibly to shorter contexts', () => {
    const p = predictor(history);
    const line = 'kubectl ';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    // "kubectl" was never seen — backoff via the space context still yields
    // candidates instead of an empty dropdown.
    expect(prediction.candidates.length).toBeGreaterThan(0);
  });

  it('line looks complete (END on top): siblings from the same context stay, backoff noise does not', () => {
    const p = predictor([
      ...repeat('git status', 5, 1 * HOURS),
      ...repeat('git status --short', 1, 3 * HOURS),
      ...repeat('cd projects', 10, 30 * 60_000), // hot, but just noise here
    ]);
    const line = 'git status ';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    // the rare flag is a real alternative from the longest context
    expect(prediction.candidates.map((c) => c.insert)).toContain('--short');
    // "projects" would only come from shorter backoff contexts -> suppressed
    expect(prediction.candidates.map((c) => c.display)).not.toContain('projects');
  });
});
