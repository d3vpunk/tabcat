import { describe, expect, it } from 'vitest';
import { RankedCandidate } from '../../src/engine/predictor.js';
import {
  HandlerContext,
  KeyEvent,
  PromptState,
  handleKey,
  initialPromptState,
} from '../../src/repl/prompt-state.js';

const key = (input: string, k: KeyEvent['key'] = {}): KeyEvent => ({ input, key: k });

const candidate = (display: string, insert?: string): RankedCandidate => ({
  display,
  insert: insert ?? display,
  score: 1,
  source: 'history',
});

const ctx = (overrides: Partial<HandlerContext> = {}): HandlerContext => ({
  candidates: [],
  prefix: '',
  recentUnique: [],
  searchResults: [],
  ...overrides,
});

/** handleKey expecting only update outcomes — saves boilerplate. */
const press = (state: PromptState, event: KeyEvent, context: HandlerContext): PromptState => {
  const outcome = handleKey(state, event, context);
  if (outcome.kind !== 'update') throw new Error(`unexpected outcome: ${outcome.kind}`);
  return outcome.state;
};

describe('Prompt state: typing & submit', () => {
  it('typing inserts at the cursor', () => {
    const state = press(initialPromptState, key('g'), ctx());
    expect(state.line).toBe('g');
    expect(state.cursor).toBe(1);
  });

  it('enter submits the line', () => {
    const outcome = handleKey({ ...initialPromptState, line: 'ls', cursor: 2 }, key('', { return: true }), ctx());
    expect(outcome).toEqual({ kind: 'submit', line: 'ls' });
  });

  it('Ctrl-D on an empty line exits the prompt', () => {
    const outcome = handleKey(initialPromptState, key('d', { ctrl: true }), ctx());
    expect(outcome.kind).toBe('exit');
  });

  it('Ctrl-D on a non-empty line deletes right of the cursor', () => {
    const state: PromptState = { ...initialPromptState, line: 'abcd', cursor: 2 };
    const deleted = press(state, key('d', { ctrl: true }), ctx());

    expect(deleted.line).toBe('abd');
    expect(deleted.cursor).toBe(2);
  });

  it('ink-delete and backspace delete left of the cursor', () => {
    const state: PromptState = { ...initialPromptState, line: 'abcd', cursor: 2 };
    const terminalBackspace = press(state, key('', { delete: true }), ctx());

    expect(terminalBackspace.line).toBe('acd');
    expect(terminalBackspace.cursor).toBe(1);
  });

  it('Ctrl-Backspace deletes one shell chunk per repeat event', () => {
    const state: PromptState = { ...initialPromptState, line: 'git status', cursor: 10 };
    const once = press(state, key('', { delete: true, ctrl: true }), ctx());
    const twice = press(once, key('', { delete: true, ctrl: true }), ctx());

    expect(once.line).toBe('git ');
    expect(twice.line).toBe('');
  });

  it('Ctrl-H backspace also deletes one shell chunk', () => {
    const state: PromptState = { ...initialPromptState, line: 'exec -it', cursor: 8 };
    const deleted = press(state, key('', { backspace: true }), ctx());

    expect(deleted.line).toBe('exec -');
  });

  it('Option/Alt-Backspace deletes three characters per repeat event', () => {
    const state: PromptState = { ...initialPromptState, line: 'abcdefgh', cursor: 8 };
    const once = press(state, key('', { delete: true, meta: true }), ctx());
    const twice = press(once, key('', { delete: true, meta: true }), ctx());

    expect(once.line).toBe('abcde');
    expect(twice.line).toBe('ab');
  });

  it('Ctrl-C clears line and undo stack', () => {
    const state: PromptState = { ...initialPromptState, line: 'rm -rf', cursor: 6, undoStack: ['rm'] };
    const cleared = press(state, key('c', { ctrl: true }), ctx());
    expect(cleared.line).toBe('');
    expect(cleared.undoStack).toEqual([]);
  });
});

describe('Prompt state: accept & undo', () => {
  it('tab replaces the typed prefix with the canonical spelling', () => {
    const state: PromptState = { ...initialPromptState, line: 'doc', cursor: 3 };
    const context = ctx({ candidates: [candidate('Documents/', 'uments/')], prefix: 'doc' });
    const accepted = press(state, key('', { tab: true }), context);

    expect(accepted.line).toBe('Documents/');
    expect(accepted.undoStack).toEqual(['doc']);
    expect(accepted.lastChangeWasAccept).toBe(true);
  });

  it('tab replaces an unescaped FS prefix with the shell-safe representation', () => {
    const state: PromptState = { ...initialPromptState, line: 'cat $', cursor: 5 };
    const safe: RankedCandidate = {
      ...candidate('\\$draft.txt', 'draft.txt'),
      source: 'fs',
      acceptedPrefixLength: 2,
    };
    const accepted = press(state, key('', { tab: true }), ctx({ candidates: [safe], prefix: '$' }));

    expect(accepted.line).toBe('cat \\$draft.txt');
  });

  it('tab with a fully typed candidate cycles to the next selection (#3)', () => {
    const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3, selected: 0 };
    const context = ctx({
      candidates: [candidate('git', ''), candidate('git status', ' status')],
      prefix: 'git',
    });
    const cycled = press(state, key('', { tab: true }), context);

    expect(cycled.selected).toBe(1);
    expect(cycled.line).toBe('git');
  });

  it('Shift-Tab undoes the last accept', () => {
    const state: PromptState = { ...initialPromptState, line: 'doc', cursor: 3 };
    const context = ctx({ candidates: [candidate('Documents/', 'uments/')], prefix: 'doc' });
    const accepted = press(state, key('', { tab: true }), context);
    const undone = press(accepted, key('', { tab: true, shift: true }), context);

    expect(undone.line).toBe('doc');
    expect(undone.undoStack).toEqual([]);
  });

  it('typing after accept anchors its own undo level — Shift-Tab eats no characters (#7)', () => {
    const state: PromptState = { ...initialPromptState, line: 'doc', cursor: 3 };
    const context = ctx({ candidates: [candidate('Documents/', 'uments/')], prefix: 'doc' });
    const accepted = press(state, key('', { tab: true }), context);
    const typed = press(accepted, key('x'), context);

    expect(typed.line).toBe('Documents/x');
    // The typed version is anchored as an undo level: first undo goes to
    // the accept state, second to the pre-accept state — nothing is lost.
    const undo1 = press(typed, key('', { tab: true, shift: true }), context);
    expect(undo1.line).toBe('Documents/');
    const undo2 = press(undo1, key('', { tab: true, shift: true }), context);
    expect(undo2.line).toBe('doc');
  });

  it('right arrow at end of line accepts only the next chunk', () => {
    const state: PromptState = { ...initialPromptState, line: '', cursor: 0 };
    const context = ctx({ candidates: [candidate('exec -it core sh')] });
    const chunked = press(state, key('', { rightArrow: true }), context);

    expect(chunked.line).toBe('exec');
  });
});

describe('Prompt state: enter on a navigated selection', () => {
  const context = ctx({
    candidates: [candidate('git status', ' status'), candidate('git commit', ' commit')],
    prefix: 'git',
  });

  it('enter at selected 0 submits the typed line unchanged', () => {
    const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3, selected: 0 };
    expect(handleKey(state, key('', { return: true }), context)).toEqual({ kind: 'submit', line: 'git' });
  });

  it('enter on a navigated candidate accepts it instead of submitting (#1)', () => {
    const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3, selected: 1 };
    const accepted = press(state, key('', { return: true }), context);

    expect(accepted.line).toBe('git commit');
    expect(accepted.selected).toBe(0); // reset -> a second enter submits
    expect(accepted.undoStack).toEqual(['git']);
  });

  it('two-stage: a second enter after the accept submits the completed line', () => {
    const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3, selected: 1 };
    const accepted = press(state, key('', { return: true }), context);
    expect(handleKey(accepted, key('', { return: true }), context)).toEqual({ kind: 'submit', line: 'git commit' });
  });

  it('enter submits when the dropdown is hidden even if a selection lingers', () => {
    const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3, selected: 1, dropdownVisible: false };
    expect(handleKey(state, key('', { return: true }), context)).toEqual({ kind: 'submit', line: 'git' });
  });

  it('enter submits when the navigated candidate is already fully typed (insert "")', () => {
    // Guard: a selected candidate whose insert is '' has nothing to accept — Tab
    // would cycle it, so Enter must fall through to submit rather than dead-key.
    const guarded = ctx({ candidates: [candidate('git status', ' status'), candidate('git', '')], prefix: 'git' });
    const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3, selected: 1 };
    expect(handleKey(state, key('', { return: true }), guarded)).toEqual({ kind: 'submit', line: 'git' });
  });
});

describe('Prompt state: history navigation', () => {
  const recentUnique = ['git status', 'make build']; // newest first

  it('up on an empty line pages backward through history', () => {
    const context = ctx({ recentUnique });
    const up1 = press(initialPromptState, key('', { upArrow: true }), context);
    expect(up1.line).toBe('git status');
    const up2 = press(up1, key('', { upArrow: true }), context);
    expect(up2.line).toBe('make build');
  });

  it('up on an empty line navigates history even with visible candidates (shell-like)', () => {
    const candidates = [candidate('git status'), candidate('make build')];
    const context = ctx({ candidates, recentUnique });
    const up = press(initialPromptState, key('', { upArrow: true }), context);

    // The last command comes back on the first ↑, not a dropdown cycle —
    // a failed command typed just before is reachable like in a real shell.
    expect(up.line).toBe('git status');
    expect(up.historyIndex).toBe(0);
    const up2 = press(up, key('', { upArrow: true }), context);
    expect(up2.line).toBe('make build');
  });

  it('down on an empty line scrolls into the dropdown, and up scrolls back', () => {
    const candidates = [candidate('git status'), candidate('make build')];
    const context = ctx({ candidates, recentUnique });
    const down = press(initialPromptState, key('', { downArrow: true }), context);
    expect(down.selected).toBe(1);
    expect(down.historyIndex).toBeNull();
    expect(down.line).toBe(''); // stays on the empty line, just moves the selection

    // Up while scrolling (selected > 0) walks the list back up, not into history.
    const up = press(down, key('', { upArrow: true }), context);
    expect(up.selected).toBe(0);
    expect(up.historyIndex).toBeNull();
    // Up again at rest on the empty line: now it goes back into history.
    const upHistory = press(up, key('', { upArrow: true }), context);
    expect(upHistory.line).toBe('git status');
  });

  it('a non-empty line without a history match holds at the top of the dropdown', () => {
    const candidates = [candidate('npm run build'), candidate('npm run test')];
    const context = ctx({ candidates, recentUnique });
    const state: PromptState = { ...initialPromptState, line: 'npm run ', cursor: 8 };
    const up = press(state, key('', { upArrow: true }), context);

    // No substring match -> ↑ at selected 0 holds; it must NOT wrap the
    // selection around to the last candidate (that made the keypress fork
    // on history contents).
    expect(up.selected).toBe(0);
    expect(up.line).toBe('npm run ');
    expect(up.historyIndex).toBeNull();
    expect(up.historyFilter).toBeNull();
  });

  it('WIP line is stashed and restored at the bottom end (#4)', () => {
    // Dropdown off (Esc) -> up with a half-typed line possible.
    const wip: PromptState = { ...initialPromptState, line: 'git st', cursor: 6, dropdownVisible: false };
    const context = ctx({ recentUnique });
    const up = press(wip, key('', { upArrow: true }), context);
    expect(up.line).toBe('git status');

    const down = press(up, key('', { downArrow: true }), context);
    expect(down.line).toBe('git st');
    expect(down.historyIndex).toBeNull();
  });

  it('up with the dropdown at rest and a typed line starts substring search (fish-style)', () => {
    const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3, selected: 0 };
    const context = ctx({
      candidates: [candidate('git'), candidate('git status', ' status')],
      prefix: 'git',
      recentUnique: ['git stash', 'git status', 'make build'],
    });
    const up = press(state, key('', { upArrow: true }), context);

    expect(up.historyFilter).toBe('git');
    expect(up.historyIndex).toBe(0);
    expect(up.line).toBe('git stash'); // newest match first
    expect(up.wipLine).toBe('git');
    expect(up.dropdownVisible).toBe(false);

    // Second up: older match
    const up2 = press(up, key('', { upArrow: true }), context);
    expect(up2.historyIndex).toBe(1);
    expect(up2.line).toBe('git status');

    // Down: back to the newest match
    const down = press(up2, key('', { downArrow: true }), context);
    expect(down.historyIndex).toBe(0);
    expect(down.line).toBe('git stash');

    // Down at the bottom end: WIP line restored, filter left
    const exitFilter = press(down, key('', { downArrow: true }), context);
    expect(exitFilter.historyFilter).toBeNull();
    expect(exitFilter.historyIndex).toBeNull();
    expect(exitFilter.line).toBe('git');
  });

  it('Esc leaves substring search mode and restores the WIP line', () => {
    const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3 };
    const context = ctx({ recentUnique: ['git stash', 'git status'] });
    const up = press(state, key('', { upArrow: true }), context);
    expect(up.historyFilter).toBe('git');

    const escaped = press(up, key('', { escape: true }), context);
    expect(escaped.historyFilter).toBeNull();
    expect(escaped.historyIndex).toBeNull();
    expect(escaped.line).toBe('git');
    expect(escaped.dropdownVisible).toBe(true);
  });

  it('typing leaves substring search mode', () => {
    const state: PromptState = { ...initialPromptState, line: 'git', cursor: 3 };
    const context = ctx({ recentUnique: ['git stash'] });
    const up = press(state, key('', { upArrow: true }), context);
    expect(up.historyFilter).toBe('git');

    const typed = press(up, key('x'), context);
    expect(typed.historyFilter).toBeNull();
    expect(typed.historyIndex).toBeNull();
    expect(typed.line).toBe('git stashx');
  });

  it('substring search without matches holds at the top of the dropdown', () => {
    const state: PromptState = { ...initialPromptState, line: 'xyz', cursor: 3, selected: 0 };
    const context = ctx({
      candidates: [candidate('xyz'), candidate('xyz-1'), candidate('xyz-2')],
      prefix: 'xyz',
      recentUnique: ['git status', 'make build'],
    });
    const up = press(state, key('', { upArrow: true }), context);
    expect(up.historyFilter).toBeNull();
    expect(up.selected).toBe(0); // held at top — no wrap to the last candidate
  });

  it('after scrolling the list down, up scrolls back up instead of searching history', () => {
    // Emil's report: ↓ scrolls the suggestion list, but ↑ jumped into history
    // search instead of scrolling back up. Once selected > 0, ↑ must cycle up.
    const context = ctx({
      candidates: [candidate('npm run build'), candidate('npm run test'), candidate('npm run lint')],
      prefix: 'npm run ',
      recentUnique: ['npm run build', 'make'],
    });
    const typed: PromptState = { ...initialPromptState, line: 'npm run ', cursor: 8, selected: 0 };
    const down = press(typed, key('', { downArrow: true }), context);
    expect(down.selected).toBe(1);

    const up = press(down, key('', { upArrow: true }), context);
    expect(up.selected).toBe(0);
    expect(up.historyFilter).toBeNull(); // did NOT hijack into history search
    expect(up.line).toBe('npm run ');
  });

  it('down walks through all candidates and wraps at the bottom back to the top', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => candidate(`cmd-${i}`));
    const context = ctx({ candidates, prefix: 'cmd' });
    let state: PromptState = { ...initialPromptState, line: 'cmd', cursor: 3 };
    for (let i = 0; i < 7; i++) state = press(state, key('', { downArrow: true }), context);
    expect(state.selected).toBe(7); // 0 -> 1 -> ... -> 7

    const wrapped = press(state, key('', { downArrow: true }), context);
    expect(wrapped.selected).toBe(0); // wraps bottom -> top

    // ↑ walks back up the list; at the top it holds (no wrap to the bottom).
    const up = press({ ...state, selected: 1 }, key('', { upArrow: true }), context);
    expect(up.selected).toBe(0);
    const held = press(up, key('', { upArrow: true }), context);
    expect(held.selected).toBe(0);
  });

  it('history selection discards completion undo context', () => {
    const state: PromptState = {
      ...initialPromptState,
      dropdownVisible: false,
      undoStack: ['unrelated completion'],
      lastChangeWasAccept: true,
    };
    const recalled = press(state, key('', { upArrow: true }), ctx({ recentUnique }));
    const undone = press(recalled, key('', { tab: true, shift: true }), ctx());

    expect(recalled.undoStack).toEqual([]);
    expect(undone.line).toBe('git status');
  });
});

describe('Prompt state: readline shortcuts', () => {
  const lineState = (line: string, cursor = line.length): PromptState => ({
    ...initialPromptState,
    line,
    cursor,
  });

  it('Ctrl-A / Ctrl-E jump to start / end of line', () => {
    const start = press(lineState('git status'), key('a', { ctrl: true }), ctx());
    expect(start.cursor).toBe(0);
    const end = press(start, key('e', { ctrl: true }), ctx());
    expect(end.cursor).toBe('git status'.length);
  });

  it('Home / End jump to start / end of line', () => {
    const home = press(lineState('git status'), key('', { home: true }), ctx());
    expect(home.cursor).toBe(0);
    const end = press(home, key('', { end: true }), ctx());
    expect(end.cursor).toBe('git status'.length);
  });

  it('Ctrl-F / Ctrl-B move the cursor by one code point', () => {
    const forward = press(lineState('git status', 0), key('f', { ctrl: true }), ctx());
    expect(forward.cursor).toBe(1);
    const mid = press(lineState('git status', 4), key('f', { ctrl: true }), ctx());
    expect(mid.cursor).toBe(5);
    const back = press(lineState('git status', 4), key('b', { ctrl: true }), ctx());
    expect(back.cursor).toBe(3);
  });

  it('Ctrl-F at end of line and Ctrl-B at start stay put', () => {
    const atEnd = press(lineState('git', 3), key('f', { ctrl: true }), ctx());
    expect(atEnd.cursor).toBe(3);
    const atStart = press(lineState('git', 0), key('b', { ctrl: true }), ctx());
    expect(atStart.cursor).toBe(0);
  });

  it('Ctrl-U kills the whole line (zsh kill-whole-line)', () => {
    const killed = press(lineState('git status', 4), key('u', { ctrl: true }), ctx());
    expect(killed.line).toBe('');
    expect(killed.cursor).toBe(0);
  });

  it('Ctrl-W kills the word left up to whitespace — path token completely', () => {
    const killed = press(lineState('vim src/app.ts'), key('w', { ctrl: true }), ctx());
    expect(killed.line).toBe('vim ');
    expect(killed.cursor).toBe(4);
  });

  it('Ctrl-W eats the whitespace run first, then the word', () => {
    const once = press(lineState('git commit   '), key('w', { ctrl: true }), ctx());
    expect(once.line).toBe('git ');
    const twice = press(once, key('w', { ctrl: true }), ctx());
    expect(twice.line).toBe('');
  });

  it('Ctrl-K kills from cursor to end of line', () => {
    const killed = press(lineState('git status', 4), key('k', { ctrl: true }), ctx());
    expect(killed.line).toBe('git ');
    expect(killed.cursor).toBe(4);
  });

  it('kill after accept anchors undo level — Shift-Tab brings back the accept state', () => {
    const state = lineState('doc', 3);
    const context = ctx({ candidates: [candidate('Documents/', 'uments/')], prefix: 'doc' });
    const accepted = press(state, key('', { tab: true }), context);
    const killed = press(accepted, key('u', { ctrl: true }), context);
    expect(killed.line).toBe('');
    const undone = press(killed, key('', { tab: true, shift: true }), context);
    expect(undone.line).toBe('Documents/');
  });

  it('Ctrl-L triggers the clear outcome without touching the line', () => {
    const outcome = handleKey(lineState('ls -la'), key('l', { ctrl: true }), ctx());
    expect(outcome.kind).toBe('clear');
    if (outcome.kind === 'clear') expect(outcome.state.line).toBe('ls -la');
  });
});

describe('Prompt state: Ctrl-R search', () => {
  const searchResults = ['git status', 'git stash'];

  it('Ctrl-R opens search mode, Esc closes it', () => {
    const opened = press(initialPromptState, key('r', { ctrl: true }), ctx());
    expect(opened.searchQuery).toBe('');
    const closed = press(opened, key('', { escape: true }), ctx());
    expect(closed.searchQuery).toBeNull();
  });

  it('typing in search mode resets the selection to the top match (#2)', () => {
    const searching: PromptState = { ...initialPromptState, searchQuery: 'git', searchSelected: 1 };
    const typed = press(searching, key(' '), ctx({ searchResults }));

    expect(typed.searchQuery).toBe('git ');
    expect(typed.searchSelected).toBe(0);
  });

  it('backspace in search mode shortens the query and resets the selection', () => {
    const searching: PromptState = { ...initialPromptState, searchQuery: 'git', searchSelected: 1 };
    const shortened = press(searching, key('', { backspace: true }), ctx());

    expect(shortened.searchQuery).toBe('gi');
    expect(shortened.searchSelected).toBe(0);
  });

  it('enter takes the chosen match into the line', () => {
    const searching: PromptState = { ...initialPromptState, searchQuery: 'git', searchSelected: 1 };
    const picked = press(searching, key('', { return: true }), ctx({ searchResults }));

    expect(picked.searchQuery).toBeNull();
    expect(picked.line).toBe('git stash');
  });

  it('search match discards completion undo context', () => {
    const searching: PromptState = {
      ...initialPromptState,
      searchQuery: 'git',
      undoStack: ['unrelated completion'],
      lastChangeWasAccept: true,
    };
    const picked = press(searching, key('', { return: true }), ctx({ searchResults }));
    const undone = press(picked, key('', { tab: true, shift: true }), ctx());

    expect(picked.undoStack).toEqual([]);
    expect(undone.line).toBe('git status');
  });
});
