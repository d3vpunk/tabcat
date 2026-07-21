import { HistoryEntry } from '../engine/model.js';

export interface ReplStats {
  entries: number;
  today: number;
  uniqueCommands: number;
  directories: number;
  successRate: number | null;
  streakDays: number;
  firstTs: number | null;
  lastTs: number | null;
  topCommands: readonly CountedValue[];
  topDirectories: readonly CountedValue[];
  telemetryEntries: number;
  savedChars: number;
  acceptRate: number | null;
  top1Rate: number | null;
  averageAcceptedChars: number | null;
  undoRate: number | null;
  averageDurationMs: number | null;
}

export interface CountedValue {
  value: string;
  count: number;
}

export function calculateReplStats(entries: readonly HistoryEntry[], now: number = Date.now()): ReplStats {
  const knownExits = entries.filter((entry) => entry.exitCode !== undefined);
  const telemetry = entries.flatMap((entry) => entry.completion ? [entry.completion] : []);
  const attempts = sum(telemetry.map((value) => value.attempts));
  const accepts = sum(telemetry.map((value) => value.accepts));
  const activeDays = new Set(entries.map((entry) => dayKey(entry.ts)));

  return {
    entries: entries.length,
    today: entries.filter((entry) => dayKey(entry.ts) === dayKey(now)).length,
    uniqueCommands: new Set(entries.map((entry) => entry.line)).size,
    directories: new Set(entries.flatMap((entry) => entry.cwd === null ? [] : [entry.cwd])).size,
    successRate: knownExits.length === 0 ? null : ratio(knownExits.filter((entry) => entry.exitCode === 0).length, knownExits.length),
    streakDays: activeStreak(activeDays),
    firstTs: entries[0]?.ts ?? null,
    lastTs: entries.at(-1)?.ts ?? null,
    topCommands: topCounts(entries.map((entry) => entry.line)),
    topDirectories: topCounts(entries.flatMap((entry) => entry.cwd === null ? [] : [entry.cwd])),
    telemetryEntries: telemetry.length,
    savedChars: sum(telemetry.map((value) => value.acceptedChars)),
    acceptRate: attempts === 0 ? null : ratio(accepts, attempts),
    top1Rate: accepts === 0 ? null : ratio(sum(telemetry.map((value) => value.top1Accepts)), accepts),
    averageAcceptedChars: accepts === 0 ? null : sum(telemetry.map((value) => value.acceptedChars)) / accepts,
    undoRate: accepts === 0 ? null : ratio(sum(telemetry.map((value) => value.undos)), accepts),
    averageDurationMs: telemetry.length === 0 ? null : sum(telemetry.map((value) => value.durationMs)) / telemetry.length,
  };
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const ratio = (part: number, total: number): number => part / total;

function topCounts(values: readonly string[], limit = 5): CountedValue[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function activeStreak(days: ReadonlySet<string>): number {
  if (days.size === 0) return 0;
  const latest = [...days].map((key) => {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year as number, month as number, day as number);
  }).sort((a, b) => b.getTime() - a.getTime())[0] as Date;
  let streak = 0;
  for (const date = new Date(latest); days.has(dayKey(date.getTime())); date.setDate(date.getDate() - 1)) streak++;
  return streak;
}
