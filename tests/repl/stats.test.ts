import { describe, expect, it } from 'vitest';
import { HistoryEntry } from '../../src/engine/model.js';
import { calculateReplStats } from '../../src/repl/stats.js';

const at = (day: number, hour = 12): number => new Date(2026, 6, day, hour).getTime();

describe('REPL stats', () => {
  it('calculates activity, success, top lists, period and streak', () => {
    const entries: HistoryEntry[] = [
      { ts: at(18), cwd: '/a', line: 'git status', exitCode: 0 },
      { ts: at(19), cwd: '/b', line: 'npm test', exitCode: 1 },
      { ts: at(20, 9), cwd: '/a', line: 'git status', exitCode: 0 },
      { ts: at(20, 10), cwd: null, line: 'git status' },
    ];

    const stats = calculateReplStats(entries, at(20));

    expect(stats).toMatchObject({
      entries: 4,
      today: 2,
      uniqueCommands: 2,
      directories: 2,
      successRate: 2 / 3,
      streakDays: 3,
      firstTs: at(18),
      lastTs: at(20, 10),
    });
    expect(stats.topCommands[0]).toEqual({ value: 'git status', count: 3 });
    expect(stats.topDirectories[0]).toEqual({ value: '/a', count: 2 });
  });

  it('aggregates completion telemetry', () => {
    const entries: HistoryEntry[] = [
      {
        ts: at(20), cwd: '/a', line: 'one', exitCode: 0,
        completion: { attempts: 3, accepts: 2, top1Accepts: 1, acceptedChars: 12, undos: 1, durationMs: 1000 },
      },
      {
        ts: at(20), cwd: '/a', line: 'two', exitCode: 0,
        completion: { attempts: 1, accepts: 1, top1Accepts: 1, acceptedChars: 6, undos: 0, durationMs: 3000 },
      },
    ];

    const stats = calculateReplStats(entries, at(20));

    expect(stats).toMatchObject({
      telemetryEntries: 2,
      savedChars: 18,
      acceptRate: 0.75,
      top1Rate: 2 / 3,
      averageAcceptedChars: 6,
      undoRate: 1 / 3,
      averageDurationMs: 2000,
    });
  });

  it('returns neutral values without history or telemetry', () => {
    const stats = calculateReplStats([], at(20));
    expect(stats.entries).toBe(0);
    expect(stats.successRate).toBeNull();
    expect(stats.acceptRate).toBeNull();
    expect(stats.topCommands).toEqual([]);
  });
});
