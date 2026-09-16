import { PassThrough } from 'node:stream';
import React, { act } from 'react';
import { render, Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptPlugin, PromptSegment } from '../../src/repl/prompt-plugins.js';
import { usePromptPlugins } from '../../src/repl/prompt-plugin-ui.js';

const { collectGit, collectClock } = vi.hoisted(() => ({
  collectGit: vi.fn<PromptPlugin['collect']>(),
  collectClock: vi.fn<PromptPlugin['collect']>(),
}));

vi.mock('../../src/repl/prompt-plugins.js', () => ({
  PROMPT_PLUGINS: [
    { id: 'git', defaultEnabled: true, collect: collectGit },
    { id: 'clock', defaultEnabled: false, intervalMs: 60_000, collect: collectClock },
  ],
}));

const left: PromptSegment = { text: 'main', tone: 'muted', side: 'left' };
const right: PromptSegment = { text: '12:00', tone: 'muted', side: 'right' };
let instance: ReturnType<typeof render> | undefined;
let streams: PassThrough[] = [];
let segments: readonly PromptSegment[] = [];

function Prompt({ enabled = {}, editing = false }: {
  enabled?: Readonly<Record<string, boolean>>;
  editing?: boolean;
}) {
  segments = usePromptPlugins('/work', enabled, editing, false);
  return <Text>{segments.map((segment) => segment.text).join(' ') || 'empty'}</Text>;
}

async function mount(element: React.ReactElement) {
  const stdin = new PassThrough();
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  const stderr = new PassThrough();
  streams = [stdin, stdout, stderr];
  stdout.resume();
  stderr.resume();
  await act(async () => {
    instance = render(element, {
      stdin: stdin as typeof process.stdin,
      stdout: stdout as typeof process.stdout,
      stderr: stderr as typeof process.stderr,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  collectGit.mockReset().mockResolvedValue(left);
  collectClock.mockReset().mockResolvedValue(right);
  segments = [];
});

afterEach(async () => {
  await act(async () => { instance?.unmount(); });
  instance?.cleanup();
  instance = undefined;
  for (const stream of streams) stream.destroy();
  streams = [];
  vi.useRealTimers();
});

describe('prompt plugin lifecycle', () => {
  it('does not collect explicitly disabled or default-disabled plugins', async () => {
    await mount(<Prompt enabled={{ git: false }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });

    expect(collectGit).not.toHaveBeenCalled();
    expect(collectClock).not.toHaveBeenCalled();
    expect(segments).toEqual([]);
  });

  it('suppresses pending left results after editing starts, but keeps right results', async () => {
    let resolveGit!: (segment: PromptSegment) => void;
    let resolveClock!: (segment: PromptSegment) => void;
    collectGit.mockImplementation(() => new Promise((resolve) => { resolveGit = resolve; }));
    collectClock.mockImplementation(() => new Promise((resolve) => { resolveClock = resolve; }));
    await mount(<Prompt enabled={{ clock: true }} />);
    expect(collectGit).toHaveBeenCalledTimes(1);
    expect(collectClock).toHaveBeenCalledTimes(1);

    await act(async () => { instance!.rerender(<Prompt enabled={{ clock: true }} editing />); });
    await act(async () => {
      resolveGit(left);
      resolveClock(right);
    });

    expect(segments).toEqual([right]);
    expect(collectGit).toHaveBeenCalledTimes(1);
    await act(async () => { instance!.rerender(<Prompt enabled={{ clock: true }} />); });
    expect(segments).toEqual([right]);
  });

  it('aborts in-flight collection on unmount without scheduling a late refresh', async () => {
    let resolveClock!: (segment: PromptSegment) => void;
    collectClock.mockImplementation(() => new Promise((resolve) => { resolveClock = resolve; }));
    await mount(<Prompt enabled={{ git: false, clock: true }} />);
    const context = collectClock.mock.calls[0]![0];
    expect(context.cwd).toBe('/work');
    expect(context.signal.aborted).toBe(false);
    const aborted = vi.fn();
    context.signal.addEventListener('abort', aborted);

    await act(async () => { instance!.unmount(); });
    expect(context.signal.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveClock(right);
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(collectClock).toHaveBeenCalledTimes(1);
    expect(segments).toEqual([]);
  });

  it('refreshes the clock on minute boundaries and stops ticking on unmount', async () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:30Z'));
    await mount(<Prompt enabled={{ git: false, clock: true }} />);
    expect(collectClock).toHaveBeenCalledTimes(1);
    expect(segments).toEqual([right]);
    collectClock.mockResolvedValue({ ...right, text: '12:01' });

    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(collectClock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(collectClock).toHaveBeenCalledTimes(2);
    expect(segments).toEqual([{ ...right, text: '12:01' }]);

    await act(async () => { instance!.unmount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(collectClock).toHaveBeenCalledTimes(2);
  });
});
