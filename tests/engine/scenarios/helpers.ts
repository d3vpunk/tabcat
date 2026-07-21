import { HistoryEntry } from '../../../src/engine/model.js';
import { Predictor } from '../../../src/engine/predictor.js';
import { FsEntry, FsLike } from '../../../src/engine/fs-completer.js';

/** Fixed "now" time for deterministic frecency tests. */
export const NOW = Date.UTC(2026, 6, 19, 12, 0, 0);

export const HOURS = 3_600_000;
export const DAYS = 86_400_000;

export const PROJECT_A = '/home/dev/project-a';
export const PROJECT_B = '/home/dev/project-b';

export function entry(line: string, agoMs: number, cwd: string = PROJECT_A): HistoryEntry {
  return { ts: NOW - agoMs, cwd, line };
}

/** n repetitions of the same command, slightly offset in time. */
export function repeat(line: string, times: number, agoMs: number, cwd: string = PROJECT_A): HistoryEntry[] {
  return Array.from({ length: times }, (_, i) => entry(line, agoMs + i * 10 * 60_000, cwd));
}

export function predictor(entries: HistoryEntry[], fs?: FsLike, home?: string): Predictor {
  return new Predictor(entries, { now: () => NOW, ...(fs ? { fs } : {}), ...(home ? { homeDir: home } : {}) });
}

/** Fake filesystem: map from absolute directory to entries. */
export function fakeFs(dirs: Record<string, FsEntry[]>): FsLike {
  return {
    readdir: (absoluteDir: string) => dirs[absoluteDir] ?? null,
  };
}

/** Simulates the tab chain: accepts the preselected candidate each time. */
export function tabChain(p: Predictor, cwd: string, maxTabs = 10): string[] {
  const steps: string[] = [];
  let line = '';
  for (let i = 0; i < maxTabs; i++) {
    const prediction = p.predict({ line, cursor: line.length, cwd });
    const top = prediction.candidates[0];
    if (!top || top.insert === '') break;
    steps.push(top.insert);
    line += top.insert;
  }
  return steps;
}
