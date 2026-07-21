import { RankedCandidate } from '../engine/predictor.js';
import { chunkAcceptEnd, nextBoundary, previousBoundary, previousChunkBoundary, previousWordBoundary } from './text-nav.js';

/**
 * The complete prompt state as pure data + pure key handler.
 * app.tsx only keeps rendering and Ink wiring — all UX rules
 * (accept, undo, history stash, Ctrl-R) are testable here without a terminal.
 */
export interface PromptState {
  line: string;
  cursor: number;
  /** Selected dropdown index (clamped to candidates at render time). */
  selected: number;
  dropdownVisible: boolean;
  undoStack: string[];
  /** null = no active history navigation, otherwise index into recentUnique. */
  historyIndex: number | null;
  /**
   * null = no substring search mode (fish-style ↑/↓ with a typed line).
   * Otherwise: the query that app.tsx filters recentUnique against.
   * historyIndex then navigates through the filtered list.
   */
  historyFilter: string | null;
  /** null = no search mode, otherwise current Ctrl-R query. */
  searchQuery: string | null;
  searchSelected: number;
  /**
   * Last line change was an accept: the next typing/deleting
   * anchors the line as its own undo level (otherwise Shift-Tab silently
   * swallows the typed characters too).
   */
  lastChangeWasAccept: boolean;
  /** Half-typed line when entering history navigation (zsh stash). */
  wipLine: string;
}

export const initialPromptState: PromptState = {
  line: '',
  cursor: 0,
  selected: 0,
  dropdownVisible: true,
  undoStack: [],
  historyIndex: null,
  historyFilter: null,
  searchQuery: null,
  searchSelected: 0,
  lastChangeWasAccept: false,
  wipLine: '',
};

/** Abstraction of Ink's key object — only what the handler needs. */
export interface KeyEvent {
  input: string;
  key: {
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    tab?: boolean;
    return?: boolean;
    escape?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    backspace?: boolean;
    delete?: boolean;
    /**
     * Home/End: Ink's useInput does not expose these, so app.tsx detects the
     * raw escape sequence and dispatches a synthetic event through handleKey.
     */
    home?: boolean;
    end?: boolean;
  };
}

/** Context recomputed per render (prediction, history, search). */
export interface HandlerContext {
  candidates: readonly RankedCandidate[];
  /** The typed, incomplete token (filter prefix of the prediction). */
  prefix: string;
  /** Newest first, deduplicated. */
  recentUnique: readonly string[];
  /** Ctrl-R search hits for the current query. */
  searchResults: readonly string[];
}

export type KeyOutcome =
  | { kind: 'update'; state: PromptState }
  /** ^L: clear the screen — rendering side effect, hence its own outcome. */
  | { kind: 'clear'; state: PromptState }
  | { kind: 'submit'; line: string }
  | { kind: 'exit' };

const update = (state: PromptState): KeyOutcome => ({ kind: 'update', state });

/** Central line change: selection, history navigation and substring filter always reset. */
const withLine = (state: PromptState, line: string, cursor: number): PromptState => ({
  ...state,
  line,
  cursor,
  selected: 0,
  historyIndex: null,
  historyFilter: null,
  wipLine: '',
});

const clampedSelected = (state: PromptState, ctx: HandlerContext): number =>
  Math.min(state.selected, Math.max(0, ctx.candidates.length - 1));

function acceptSelected(state: PromptState, ctx: HandlerContext): PromptState {
  const selectedIndex = clampedSelected(state, ctx);
  const candidate = ctx.candidates[selectedIndex];
  // Candidate already fully typed (insert === '') -> Tab cycles to the
  // next candidate instead of ending as a dead key without feedback.
  if (!candidate || candidate.insert === '') {
    if (ctx.candidates.length > 1) {
      return { ...state, selected: (selectedIndex + 1) % ctx.candidates.length };
    }
    return state;
  }
  // The typed prefix is REPLACED by the candidate instead of just
  // appended — case-insensitive hits thus correct the spelling
  // ("doc" + Tab -> "Documents").
  const replaceFrom = state.cursor - (candidate.replacePrefixLength ?? ctx.prefix.length);
  return {
    ...withLine(
      state,
      state.line.slice(0, replaceFrom) + candidate.display + state.line.slice(state.cursor),
      replaceFrom + candidate.display.length,
    ),
    undoStack: [...state.undoStack, state.line],
    lastChangeWasAccept: true,
    dropdownVisible: true,
  };
}

function acceptNextChunk(state: PromptState, ctx: HandlerContext): PromptState {
  const selectedIndex = clampedSelected(state, ctx);
  const candidate = ctx.candidates[selectedIndex];
  if (!candidate || candidate.insert === '') return state;
  const covered = candidate.acceptedPrefixLength ?? ctx.prefix.length;
  const partial = candidate.display.slice(0, chunkAcceptEnd(candidate.display, covered));
  if (partial.length <= covered) return state;
  const replaceFrom = state.cursor - (candidate.replacePrefixLength ?? ctx.prefix.length);
  return {
    ...withLine(
      state,
      state.line.slice(0, replaceFrom) + partial + state.line.slice(state.cursor),
      replaceFrom + partial.length,
    ),
    undoStack: [...state.undoStack, state.line],
    lastChangeWasAccept: true,
    dropdownVisible: true,
  };
}

function undoLastAccept(state: PromptState): PromptState {
  const previous = state.undoStack.at(-1);
  if (previous === undefined) return state;
  return {
    ...withLine({ ...state, undoStack: state.undoStack.slice(0, -1) }, previous, previous.length),
    lastChangeWasAccept: false,
  };
}

function navigateHistory(state: PromptState, direction: -1 | 1, ctx: HandlerContext): PromptState {
  if (ctx.recentUnique.length === 0) return state;
  const wipLine = state.historyIndex === null && direction === -1 ? state.line : state.wipLine;
  const next =
    state.historyIndex === null
      ? direction === -1
        ? 0
        : null
      : state.historyIndex + (direction === -1 ? 1 : -1);
  if (next === null || next < 0) {
    // Bottom end: the stashed WIP line comes back (zsh behavior).
    return { ...state, historyIndex: null, line: wipLine, cursor: wipLine.length, wipLine: '' };
  }
  const clamped = Math.min(next, ctx.recentUnique.length - 1);
  const entry = ctx.recentUnique[clamped];
  if (entry === undefined) return state;
  return {
    ...state,
    historyIndex: clamped,
    line: entry,
    cursor: entry.length,
    selected: 0,
    wipLine,
    undoStack: [],
    lastChangeWasAccept: false,
  };
}

/**
 * fish-style substring search: ↑ with a typed line starts the search,
 * selecting the newest history entry containing the line as a substring.
 * Further ↑ page to older hits, ↓ to newer ones. At the bottom end
 * (or via Esc) the WIP line comes back. app.tsx already filters
 * recentUnique by historyFilter — this only navigates.
 */
function navigateSubstring(state: PromptState, direction: -1 | 1, ctx: HandlerContext): PromptState {
  if (state.historyFilter === null) return state;
  if (ctx.recentUnique.length === 0) return state;
  const next = (state.historyIndex ?? -1) + (direction === -1 ? 1 : -1);
  if (next < 0) {
    // Newer than the newest hit: restore WIP line, leave the filter.
    return {
      ...state,
      historyFilter: null,
      historyIndex: null,
      line: state.wipLine,
      cursor: state.wipLine.length,
      wipLine: '',
      dropdownVisible: true,
    };
  }
  const clamped = Math.min(next, ctx.recentUnique.length - 1);
  const entry = ctx.recentUnique[clamped];
  if (entry === undefined) return state;
  return {
    ...state,
    historyIndex: clamped,
    line: entry,
    cursor: entry.length,
  };
}

function startSubstringSearch(state: PromptState, ctx: HandlerContext): PromptState {
  if (ctx.recentUnique.length === 0 || state.line === '') return state;
  // On the first ↑, ctx.recentUnique is still unfiltered (historyFilter === null).
  const filtered = ctx.recentUnique.filter((line) => line.includes(state.line));
  const first = filtered[0];
  if (first === undefined) return state; // no hit: do nothing, dropdown stays visible.
  return {
    ...state,
    historyFilter: state.line,
    historyIndex: 0,
    line: first,
    cursor: first.length,
    wipLine: state.line,
    selected: 0,
    undoStack: [],
    lastChangeWasAccept: false,
    dropdownVisible: false,
  };
}

/** Typing/deleting right after an accept anchors its own undo level. */
const anchorAfterAccept = (state: PromptState): PromptState =>
  state.lastChangeWasAccept
    ? { ...state, undoStack: [...state.undoStack, state.line], lastChangeWasAccept: false }
    : state;

export function handleKey(state: PromptState, event: KeyEvent, ctx: HandlerContext): KeyOutcome {
  const { input, key } = event;

  // --- Ctrl-R search mode ---
  if (state.searchQuery !== null) {
    if (key.escape || (key.ctrl && input === 'c')) {
      return update({ ...state, searchQuery: null });
    }
    if (key.return) {
      const picked = ctx.searchResults[state.searchSelected];
      const next = { ...state, searchQuery: null, undoStack: [], lastChangeWasAccept: false };
      return update(picked !== undefined ? withLine(next, picked, picked.length) : next);
    }
    if (key.upArrow) return update({ ...state, searchSelected: Math.max(state.searchSelected - 1, 0) });
    if (key.downArrow)
      return update({ ...state, searchSelected: Math.min(state.searchSelected + 1, ctx.searchResults.length - 1) });
    // Query change resets the selection to the top hit — otherwise
    // searchSelected points into the void after the hit list shrinks.
    if (key.backspace || key.delete) {
      const query = state.searchQuery;
      const boundary = key.meta
        ? previousNBoundaries(query, query.length, 3)
        : key.ctrl
          ? previousChunkBoundary(query, query.length)
          : previousBoundary(query, query.length);
      return update({ ...state, searchQuery: query.slice(0, boundary), searchSelected: 0 });
    }
    if (input && !key.ctrl && !key.meta) {
      return update({ ...state, searchQuery: state.searchQuery + input, searchSelected: 0 });
    }
    return update(state);
  }

  if (key.ctrl && input === 'r') {
    return update({ ...state, searchQuery: '', searchSelected: 0, historyFilter: null, historyIndex: null });
  }
  if (key.ctrl && input === 'c') {
    return update({ ...withLine(state, '', 0), undoStack: [], lastChangeWasAccept: false });
  }
  if (key.ctrl && input === 'd' && state.line === '') return { kind: 'exit' };
  if (key.ctrl && input === 'd') return update(deleteForward(state));

  // Readline/zsh muscle memory: line jumps and kills. Kills delete like
  // Backspace -> they also anchor an undo level after an accept.
  if ((key.ctrl && input === 'a') || key.home) return update({ ...state, cursor: 0 });
  if ((key.ctrl && input === 'e') || key.end) return update({ ...state, cursor: state.line.length });
  // Readline char motion (^f/^b): arrows in text form — power-user muscle memory.
  if (key.ctrl && input === 'f') return update({ ...state, cursor: nextBoundary(state.line, state.cursor) });
  if (key.ctrl && input === 'b') return update({ ...state, cursor: previousBoundary(state.line, state.cursor) });
  if (key.ctrl && input === 'u') {
    // zsh kill-whole-line: ^U takes the WHOLE line, not just left of the cursor.
    return update(withLine(anchorAfterAccept(state), '', 0));
  }
  if (key.ctrl && input === 'w') {
    const anchored = anchorAfterAccept(state);
    const wordStart = previousWordBoundary(anchored.line, anchored.cursor);
    return update(
      withLine(anchored, anchored.line.slice(0, wordStart) + anchored.line.slice(anchored.cursor), wordStart),
    );
  }
  if (key.ctrl && input === 'k') {
    const anchored = anchorAfterAccept(state);
    return update(withLine(anchored, anchored.line.slice(0, anchored.cursor), anchored.cursor));
  }
  if (key.ctrl && input === 'l') return { kind: 'clear', state };

  if (key.return) return { kind: 'submit', line: state.line };

  if (key.tab && key.shift) return update(undoLastAccept(state));
  if (key.tab) return update(acceptSelected(state, ctx));

  if (key.escape) {
    // Esc in substring search mode: WIP line back, dropdown on again.
    if (state.historyFilter !== null) {
      return update({
        ...state,
        historyFilter: null,
        historyIndex: null,
        line: state.wipLine,
        cursor: state.wipLine.length,
        wipLine: '',
        dropdownVisible: true,
      });
    }
    return update({ ...state, dropdownVisible: false });
  }

  // Up/Down context-dependent:
  // - Empty line: history navigation, like a standard shell — the last command
  //   (including a failed one) comes back on the first ↑, even with a frecency
  //   dropdown showing. Tab still accepts the top dropdown candidate.
  // - Non-empty line + visible dropdown: fish-style substring search through
  //   history (↑ older hit, ↓ newer). Only when the line has no history match
  //   do ↑/↓ cycle the dropdown selection.
  // Esc hides the dropdown -> history gets through.
  if (key.upArrow) {
    // fish-style substring search: non-empty line + visible dropdown
    // starts the search. startSubstringSearch returns state unchanged if
    // there are no hits — then it falls into the dropdown cycle below.
    if (state.line !== '' && state.dropdownVisible && state.historyFilter === null && state.historyIndex === null) {
      const started = startSubstringSearch(state, ctx);
      if (started !== state) return update(started);
    }
    if (state.historyFilter !== null) {
      return update(navigateSubstring(state, -1, ctx));
    }
    if (state.line === '' || state.historyIndex !== null || !state.dropdownVisible || ctx.candidates.length === 0) {
      return update(navigateHistory(state, -1, ctx));
    }
    return update({ ...state, selected: (clampedSelected(state, ctx) - 1 + ctx.candidates.length) % ctx.candidates.length });
  }
  if (key.downArrow) {
    if (state.historyFilter !== null) {
      return update(navigateSubstring(state, 1, ctx));
    }
    if (state.line === '' || state.historyIndex !== null || !state.dropdownVisible || ctx.candidates.length === 0) {
      return update(navigateHistory(state, 1, ctx));
    }
    return update({ ...state, selected: (clampedSelected(state, ctx) + 1) % ctx.candidates.length });
  }

  if (key.leftArrow) return update({ ...state, cursor: previousBoundary(state.line, state.cursor) });
  // Right at end of line accepts chunk by chunk from the ghost (Tab = everything) —
  // otherwise the arrow just moves the cursor by one code point.
  if (key.rightArrow) {
    if (state.cursor === state.line.length && ctx.candidates[clampedSelected(state, ctx)]?.insert) {
      return update(acceptNextChunk(state, ctx));
    }
    return update({ ...state, cursor: nextBoundary(state.line, state.cursor) });
  }

  // Ink 5: normal Backspace (DEL) = delete; Ctrl-Backspace is, depending on
  // the terminal, ctrl+delete or Ctrl-H = backspace. Option (macOS) and Alt
  // (Linux) both arrive as meta. Key repeat delivers fast successive events.
  if (key.backspace || key.delete) {
    if (state.cursor === 0) return update(state);
    const anchored = anchorAfterAccept(state);
    const previous = backspaceBoundary(anchored.line, anchored.cursor, key);
    return update({
      ...withLine(anchored, anchored.line.slice(0, previous) + anchored.line.slice(anchored.cursor), previous),
      dropdownVisible: true,
    });
  }

  if (input && !key.ctrl && !key.meta) {
    const anchored = anchorAfterAccept(state);
    return update({
      ...withLine(
        anchored,
        anchored.line.slice(0, anchored.cursor) + input + anchored.line.slice(anchored.cursor),
        anchored.cursor + input.length,
      ),
      dropdownVisible: true,
    });
  }

  return update(state);
}

function backspaceBoundary(text: string, cursor: number, key: KeyEvent['key']): number {
  if (key.meta) return previousNBoundaries(text, cursor, 3);
  if (key.ctrl || key.backspace) return previousChunkBoundary(text, cursor);
  return previousBoundary(text, cursor);
}

function previousNBoundaries(text: string, cursor: number, count: number): number {
  let boundary = cursor;
  for (let i = 0; i < count && boundary > 0; i++) boundary = previousBoundary(text, boundary);
  return boundary;
}

function deleteForward(state: PromptState): PromptState {
  if (state.cursor >= state.line.length) return state;
  const anchored = anchorAfterAccept(state);
  const next = nextBoundary(anchored.line, anchored.cursor);
  return {
    ...withLine(anchored, anchored.line.slice(0, anchored.cursor) + anchored.line.slice(next), anchored.cursor),
    dropdownVisible: true,
  };
}
