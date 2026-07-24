import { describe, expect, it } from 'vitest';
import { ReplOutput, acceptedLineFor, clampMinimalDisplay, extractPaste, homeEndKey, isMultilinePaste, legendVisible, lineWindow, magicCandidates, magicCommandHints, sanitizeInsert, shortenCwd, singleLine, splitMatched, trackCompletion, truncateEnd, truncateMiddle } from '../../src/repl/app.js';
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

describe('minimal variant row clamp', () => {
  it('leaves a fitting display untouched', () => {
    expect(clampMinimalDisplay('git status', 80, 10)).toBe('git status');
  });

  it('truncates so display + overhead + indent never wrap', () => {
    const long = 'git commit --amend --no-edit --all --signoff --verbose';
    const clamped = clampMinimalDisplay(long, 40, 12);
    expect(clamped.length).toBeLessThanOrEqual(40 - 6 - 12);
    expect(clamped.endsWith('…')).toBe(true);
  });

  it('keeps a 10-column stub on tiny panes', () => {
    const clamped = clampMinimalDisplay('some-long-command --flag', 20, 18);
    expect(clamped.length).toBe(10);
    expect(clamped.endsWith('…')).toBe(true);
  });
});

describe('minimal variant legend', () => {
  const idle = { pasted: null, searchQuery: null, discoveryHandle: null, magicHints: null, dropdownOpen: false };

  it('full mode always shows the legend', () => {
    expect(legendVisible(false, idle)).toBe(true);
    expect(legendVisible(false, { ...idle, dropdownOpen: true })).toBe(true);
  });

  it('minimal hides the legend in the default and dropdown states', () => {
    expect(legendVisible(true, idle)).toBe(false);
    expect(legendVisible(true, { ...idle, dropdownOpen: true })).toBe(false);
    expect(legendVisible(true, { ...idle, magicHints: [] })).toBe(false);
  });

  it('minimal keeps the paste and search hints (modes behave as in full)', () => {
    expect(legendVisible(true, { ...idle, pasted: 'a\nb' })).toBe(true);
    expect(legendVisible(true, { ...idle, searchQuery: 'git' })).toBe(true);
  });

  it('minimal shows the discovery badge only when the line below the prompt is free', () => {
    expect(legendVisible(true, { ...idle, discoveryHandle: 'deploy' })).toBe(true);
    expect(legendVisible(true, { ...idle, discoveryHandle: 'deploy', dropdownOpen: true })).toBe(false);
    expect(legendVisible(true, { ...idle, discoveryHandle: 'deploy', magicHints: [] })).toBe(false);
  });
});

describe('REPL commands', () => {
  const context = { cwd: '/work', historyFile: '/history.jsonl', entries: [] };

  it('shows help for :help', () => {
    let shown = 0;

    expect(handleReplCommand(':help', { ...context, showHelp: () => shown++ })).toBe('handled');
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
    expect(handleReplCommand(':version', commandContext)).toBe('handled');
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
    expect(handleReplCommand(':exit', context)).toBe('exit');
  });

  it('dispatches the cat animation', () => {
    expect(handleReplCommand(':meow', context)).toBe('meow');
  });

  it(':names lists handles, active-in-this-directory first', () => {
    const output: ReplOutput[] = [];
    const names = [
      { name: 'elsewhere', line: 'cmd-a', cwds: ['/other'], ts: 3 },
      { name: 'here', line: 'cmd-b', cwds: ['/work'], ts: 1 },
      { name: 'everywhere', line: 'cmd-c', cwds: [], ts: 2 },
    ];

    expect(handleReplCommand(':names', { ...context, names, showOutput: (value) => output.push(value) })).toBe('handled');
    expect(output[0]).toEqual({
      kind: 'names',
      names: [
        { name: 'everywhere', line: 'cmd-c', active: true },
        { name: 'here', line: 'cmd-b', active: true },
        { name: 'elsewhere', line: 'cmd-a', active: false },
      ],
    });
  });

  it(':names without an index shows an empty list', () => {
    const output: ReplOutput[] = [];
    expect(handleReplCommand(':names', { ...context, showOutput: (value) => output.push(value) })).toBe('handled');
    expect(output[0]).toEqual({ kind: 'names', names: [] });
  });

  it('acceptedLineFor previews the replace-prefix accept (discovery badge)', () => {
    const candidate = { display: 'git status', insert: ' status', score: 1, source: 'history' as const };
    expect(acceptedLineFor('git', 3, candidate, 3)).toBe('git status');

    const replacing = { ...candidate, replacePrefixLength: 2 };
    expect(acceptedLineFor('gi', 2, replacing, 2)).toBe('git status');
  });

  it('passes unknown magic commands through to the shell', () => {
    expect(handleReplCommand(':unknown', context)).toBe('unhandled');
    expect(handleReplCommand('/usr/bin/env', context)).toBe('unhandled');
  });

  it('does not treat the slash prefix as a magic command', () => {
    expect(handleReplCommand('/help', context)).toBe('unhandled');
    expect(handleReplCommand('/meow', context)).toBe('unhandled');
    expect(handleReplCommand('/exit', context)).toBe('unhandled');
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

  it('counts enter-accept on a navigated selection (not top-1)', () => {
    const two = [
      { display: 'git status', insert: ' status', score: 2, source: 'history' as const },
      { display: 'git commit', insert: ' commit', score: 1, source: 'history' as const },
    ];
    const navigated: PromptState = { ...state, selected: 1 };
    const next = { ...navigated, line: 'git commit', cursor: 10, selected: 0 };
    expect(trackCompletion(empty, navigated, { input: '', key: { return: true } }, { kind: 'update', state: next }, two, 1)).toEqual({
      attempts: 1, accepts: 1, top1Accepts: 0, acceptedChars: 7, undos: 0,
    });
  });

  it('does not count a plain enter submit at selected 0 as an attempt', () => {
    expect(trackCompletion(empty, state, { input: '', key: { return: true } }, { kind: 'submit', line: 'git' }, candidates, 0)).toEqual(empty);
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
      ':help', ':history', ':names', ':stats', ':version', ':cwd', ':clear', ':meow', ':exit',
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

  // Ink's useInput strips the leading ESC from each chunk, so a paste that
  // fills a whole chunk reaches extractPaste as "[200~…" without its ESC.
  it('detects a paste whose leading ESC was stripped by Ink', () => {
    const ref = pasteRef();
    expect(extractPaste('[200~gh auth login[201~', ref)).toBe('gh auth login');
    expect(ref.current.active).toBe(false);
    expect(ref.current.buffer).toBe('');
  });

  it('detects an ESC-stripped start marker with an ESC-kept end marker', () => {
    const ref = pasteRef();
    expect(extractPaste('[200~pasted\x1b[201~', ref)).toBe('pasted');
    expect(ref.current.active).toBe(false);
  });
});

// Applied to pastes AND raw multi-character bursts (terminal type-ahead that
// queued up before the prompt read it — iTerm "Send text at start", tmux
// send-keys). Newlines must never reach the editor line, control bytes and
// U+FFFD (half-eaten byte sequences from a previous tty reader) are dropped.
describe('Block input sanitizing (sanitizeInsert)', () => {
  it('collapses newlines and tabs to a single space', () => {
    expect(sanitizeInsert('mkdir -p ~/base\ncd ~/base')).toBe('mkdir -p ~/base cd ~/base');
    expect(sanitizeInsert('a\r\n\tb')).toBe('a b');
  });

  it('drops control characters and U+FFFD', () => {
    expect(sanitizeInsert('��-H \x07foo\x00')).toBe('-H foo');
    expect(sanitizeInsert('\x1b[Afoo')).toBe('[Afoo'); // ESC dies, printable remnant stays
  });

  it('leaves plain text, spaces and emoji untouched', () => {
    expect(sanitizeInsert('git status ')).toBe('git status ');
    expect(sanitizeInsert('echo "😀 fïn"')).toBe('echo "😀 fïn"');
  });
});

describe('Multiline paste detection (isMultilinePaste)', () => {
  it('a single command with a trailing newline stays inline', () => {
    expect(isMultilinePaste('git status\n')).toBe(false);
    expect(isMultilinePaste('git status\r\n  ')).toBe(false);
    expect(isMultilinePaste('git status')).toBe(false);
  });

  it('interior newlines make it a block', () => {
    expect(isMultilinePaste("curl 'x' \\\n  -X 'OPTIONS'\n")).toBe(true);
    expect(isMultilinePaste('ls\npwd')).toBe(true);
    expect(isMultilinePaste('a\r\nb')).toBe(true);
  });
});

describe('Home/End sequence mapping (homeEndKey)', () => {
  it('maps the common Home encodings', () => {
    for (const seq of ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~']) {
      expect(homeEndKey(seq)).toBe('home');
    }
  });

  it('maps the common End encodings', () => {
    for (const seq of ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~']) {
      expect(homeEndKey(seq)).toBe('end');
    }
  });

  it('returns null for anything else', () => {
    expect(homeEndKey('a')).toBeNull();
    expect(homeEndKey('\x1b[A')).toBeNull(); // up arrow
    expect(homeEndKey('')).toBeNull();
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
