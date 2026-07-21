import { describe, expect, it } from 'vitest';
import { ReplOutput, extractPaste, lineWindow, magicCandidates, magicCommandHints, shortenCwd, singleLine, splitMatched, trackCompletion, truncateEnd, truncateMiddle } from '../../src/repl/app.js';
import { PromptState, handleKey, initialPromptState } from '../../src/repl/prompt-state.js';
import { handleReplCommand, isInteractiveTerminal } from '../../src/repl/run.js';

describe('REPL environment', () => {
  it('accepts only input and output with TTY', () => {
    expect(isInteractiveTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractiveTerminal({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractiveTerminal({ isTTY: true }, { isTTY: undefined })).toBe(false);
  });

  it('shortens cwd with explicit home directory', () => {
    expect(shortenCwd('/home/user', '/home/user')).toBe('~');
    expect(shortenCwd('/home/user/project', '/home/user')).toBe('~/project');
  });

  it('does not confuse directories with the same prefix with home', () => {
    expect(shortenCwd('/home/user-two/project', '/home/user')).toBe('/home/user-two/project');
  });
});

describe('REPL commands', () => {
  const context = { cwd: '/work', historyFile: '/history.jsonl', entries: [] };

  it.each([':help', '/help'])('shows help for %s', (line) => {
    let shown = 0;

    expect(handleReplCommand(line, { ...context, showHelp: () => shown++ })).toBe('handled');
    expect(shown).toBe(1);
  });

  it('shows the last 10 history entries with running number', () => {
    const output: ReplOutput[] = [];
    const entries = Array.from({ length: 12 }, (_, index) => ({ ts: index, cwd: '/work', line: `cmd ${index + 1}` }));

    expect(handleReplCommand(':history', { ...context, entries, showOutput: (value) => output.push(value) })).toBe('handled');
    expect(output[0]).toEqual({
      kind: 'history',
      entries: Array.from({ length: 10 }, (_, index) => ({ number: index + 3, line: `cmd ${index + 3}` })),
    });
  });

  it('shows stats, version and cwd', () => {
    const output: ReplOutput[] = [];
    const entries = [
      { ts: 1, cwd: '/one', line: 'one' },
      { ts: 2, cwd: '/two', line: 'two' },
      { ts: 3, cwd: '/one', line: 'three' },
    ];
    const commandContext = { ...context, entries, showOutput: (value: ReplOutput) => output.push(value) };

    expect(handleReplCommand(':stats', commandContext)).toBe('handled');
    expect(handleReplCommand('/version', commandContext)).toBe('handled');
    expect(handleReplCommand(':cwd', commandContext)).toBe('handled');
    expect(output[0]).toMatchObject({
      kind: 'stats',
      historyFile: '/history.jsonl',
      stats: { entries: 3, directories: 2, uniqueCommands: 3 },
    });
    expect(output[1]).toMatchObject({ kind: 'version', version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    expect(output[2]).toEqual({ kind: 'cwd', cwd: '/work' });
  });

  it('clears the screen and exits the REPL', () => {
    let cleared = 0;
    expect(handleReplCommand(':clear', { ...context, clear: () => cleared++ })).toBe('handled');
    expect(cleared).toBe(1);
    expect(handleReplCommand('/exit', context)).toBe('exit');
  });

  it('dispatches the cat animation', () => {
    expect(handleReplCommand(':meow', context)).toBe('meow');
    expect(handleReplCommand('/meow', context)).toBe('meow');
  });

  it('passes unknown magic commands through to the shell', () => {
    expect(handleReplCommand(':unknown', context)).toBe('unhandled');
    expect(handleReplCommand('/usr/bin/env', context)).toBe('unhandled');
  });
});

describe('Completion telemetry', () => {
  const empty = { attempts: 0, accepts: 0, top1Accepts: 0, acceptedChars: 0, undos: 0 };
  const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3 };
  const candidates = [
    { display: 'git status', insert: ' status', score: 2, source: 'history' as const },
  ];

  it('counts accept, top-1 and saved characters', () => {
    const next = { ...state, line: 'git status', cursor: 10 };
    expect(trackCompletion(empty, state, { input: '', key: { tab: true } }, { kind: 'update', state: next }, candidates, 0)).toEqual({
      attempts: 1, accepts: 1, top1Accepts: 1, acceptedChars: 7, undos: 0,
    });
  });

  it('counts failed attempt and undo separately', () => {
    const missed = trackCompletion(empty, state, { input: '', key: { tab: true } }, { kind: 'update', state }, [], 0);
    const acceptedState = { ...state, line: 'git status', cursor: 10, undoStack: ['git'] };
    const undone = trackCompletion(missed, acceptedState, { input: '', key: { tab: true, shift: true } }, { kind: 'update', state }, candidates, 0);
    expect(undone).toEqual({ attempts: 1, accepts: 0, top1Accepts: 0, acceptedChars: 0, undos: 1 });
  });
});

describe('Stats text layout', () => {
  it('normalizes multi-line commands and truncates deterministically', () => {
    expect(singleLine('claude\n  --dangerously-skip-permissions')).toBe('claude --dangerously-skip-permissions');
    expect(truncateEnd('abcdefghijkl', 8)).toBe('abcdefg…');
    expect(truncateMiddle('/very/long/project/path', 12)).toBe('/very/…/path');
  });
});

describe('Magic command hints', () => {
  it('shows all commands after a colon', () => {
    expect(magicCommandHints(':')?.map(({ command }) => command)).toEqual([
      ':help', ':history', ':stats', ':version', ':cwd', ':clear', ':meow', ':exit',
    ]);
  });

  it('filters by the typed prefix', () => {
    expect(magicCommandHints(':h')?.map(({ command }) => command)).toEqual([':help', ':history']);
    expect(magicCommandHints(':hist')?.map(({ command }) => command)).toEqual([':history']);
    expect(magicCommandHints(':nope')).toEqual([]);
  });

  it('does not activate hints for normal shell lines', () => {
    expect(magicCommandHints('git status')).toBeNull();
    expect(magicCommandHints('/usr/bin/env')).toBeNull();
    expect(magicCommandHints(':help now')).toBeNull();
  });

  it('returns tabbable candidates from the fixed list', () => {
    expect(magicCandidates(':me', 3)?.map((candidate) => candidate.display)).toEqual([':meow']);
    expect(magicCandidates(':h', 2)?.map((candidate) => candidate.display)).toEqual([':help', ':history']);
    expect(magicCandidates('git status', 10)).toBeNull();
  });

  it('accepts a magic command via tab including undo', () => {
    const state: PromptState = { ...initialPromptState, line: ':me', cursor: 3 };
    const context = {
      candidates: magicCandidates(':me', 3) ?? [],
      prefix: '',
      recentUnique: [],
      searchResults: [],
    };

    const accepted = handleKey(state, { input: '', key: { tab: true } }, context);
    expect(accepted).toMatchObject({ kind: 'update', state: { line: ':meow', cursor: 5 } });

    if (accepted.kind !== 'update') throw new Error('Tab without update');
    const undone = handleKey(accepted.state, { input: '', key: { tab: true, shift: true } }, context);
    expect(undone).toMatchObject({ kind: 'update', state: { line: ':me', cursor: 3 } });
  });
});

describe('Bracketed paste detection', () => {
  const pasteRef = () => ({ current: { active: false, buffer: '' } });

  it('detects a complete paste in one chunk', () => {
    const ref = pasteRef();
    expect(extractPaste('\x1b[200~pasted\x1b[201~', ref)).toBe('pasted');
    expect(ref.current.active).toBe(false);
    expect(ref.current.buffer).toBe('');
  });

  it('accumulates a paste across two chunks', () => {
    const ref = pasteRef();
    expect(extractPaste('\x1b[200~partial', ref)).toBeNull();
    expect(ref.current.active).toBe(true);
    expect(ref.current.buffer).toBe('partial');
    expect(extractPaste(' rest\x1b[201~', ref)).toBe('partial rest');
    expect(ref.current.active).toBe(false);
    expect(ref.current.buffer).toBe('');
  });

  it('lets normal input pass through unchanged (null)', () => {
    const ref = pasteRef();
    expect(extractPaste('git status', ref)).toBeNull();
    expect(ref.current.active).toBe(false);
  });

  it('ignores the end marker without an active paste', () => {
    const ref = pasteRef();
    expect(extractPaste('foo\x1b[201~bar', ref)).toBeNull();
    expect(ref.current.active).toBe(false);
  });
});

describe('Dropdown prefix highlighting (splitMatched)', () => {
  it('separates the typed prefix from the completion rest', () => {
    expect(splitMatched('git status', 3)).toEqual({ matched: 'git', rest: ' status' });
    expect(splitMatched('Documents/', 3)).toEqual({ matched: 'Doc', rest: 'uments/' });
  });

  it('without a prefix everything is rest', () => {
    expect(splitMatched('git status', 0)).toEqual({ matched: '', rest: 'git status' });
  });

  it('clamps matchedLen to the display length', () => {
    expect(splitMatched('git', 10)).toEqual({ matched: 'git', rest: '' });
  });

  it('treats negative matchedLen as 0', () => {
    expect(splitMatched('git status', -1)).toEqual({ matched: '', rest: 'git status' });
  });
});

describe('Long line window (lineWindow)', () => {
  it('short lines are rendered completely', () => {
    const win = lineWindow('git status', 10, 80);
    expect(win.before).toBe('git status');
    expect(win.at).toBe('');
    expect(win.after).toBe('');
  });

  it('line beyond avail is truncated with … markers, cursor stays visible', () => {
    const line = 'a'.repeat(100);
    const win = lineWindow(line, 50, 20);
    expect(win.before.startsWith('…')).toBe(true);
    expect(win.after.endsWith('…')).toBe(true);
    // Cursor is at the start of the `at` slice — the inverse block.
    expect(win.at).toBe('a');
  });

  it('cursor at the start: no left marker, cursor stays visible', () => {
    const line = 'a'.repeat(100);
    const win = lineWindow(line, 0, 20);
    expect(win.before.startsWith('…')).toBe(false);
    expect(win.after.endsWith('…')).toBe(true);
    expect(win.at).toBe('a');
  });

  it('cursor at the end: no right marker, cursor stays visible', () => {
    const line = 'a'.repeat(100);
    const win = lineWindow(line, 100, 20);
    expect(win.before.startsWith('…')).toBe(true);
    expect(win.after.endsWith('…')).toBe(false);
    expect(win.at).toBe(' ');
  });

  it('ghostRemain is positive when cursor is at end of line and space in window', () => {
    const win = lineWindow('git', 3, 80);
    expect(win.ghostRemain).toBe(77);
  });
});
