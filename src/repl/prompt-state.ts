import { RankedCandidate } from '../engine/predictor.js';
import { NameIndex, NameScope, scopeOf, validateHandle } from '../engine/names.js';
import { chunkAcceptEnd, nextBoundary, previousBoundary, previousChunkBoundary, previousWordBoundary } from './text-nav.js';

/** Handle-in-progress plus the level it would be saved on (^G toggles). */
export interface NamingState {
  handle: string;
  scope: NameScope;
}

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
  /**
   * null = not naming; otherwise the handle-in-progress of the Ctrl+N badge
   * together with the scope it would be saved on ('' = badge open and empty).
   * The command line freezes while naming — only the handle is being edited.
   */
  naming: NamingState | null;
  /**
   * null = no multiline paste pending; otherwise the pasted block, verbatim.
   * The whole completion machinery is bypassed — Enter runs the block exactly
   * as pasted (shell semantics stay intact: continuations, quoting, one
   * command per line), Esc discards it.
   */
  pasted: string | null;
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
  naming: null,
  pasted: null,
};

/**
 * Enters paste mode for a multiline block: CRLF normalized, control characters
 * (except newline and tab) dropped, trailing whitespace stripped. Anything the
 * user had typed wraps around the block at the cursor — `sudo ` + paste works.
 * Transient modes (naming, search, history filter) are cancelled.
 */
export function enterPasteMode(state: PromptState, paste: string): PromptState {
  const block = (
    state.line.slice(0, state.cursor) +
    paste.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\uFFFD]/g, '') +
    state.line.slice(state.cursor)
  ).replace(/\s+$/, '');
  if (block === '') return state;
  return { ...state, pasted: block, naming: null, searchQuery: null, historyFilter: null, historyIndex: null };
}

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
  /** Magic-name index; absent = feature dormant (Ctrl+N no-op, no resolution). */
  names?: NameIndex;
  /** Directory the prompt runs in — scopes magic handles. */
  cwd?: string;
}

export type KeyOutcome =
  | { kind: 'update'; state: PromptState }
  /** ^L: clear the screen — rendering side effect, hence its own outcome. */
  | { kind: 'clear'; state: PromptState }
  /**
   * saveName is only present when the submit came out of the naming badge:
   * a valid handle = create/overwrite on its scope, an empty handle = badge
   * left empty (delete the handle if the command had one). Absent on every
   * normal submit — and on a naming submit whose handle was invalid
   * (execute, skip save).
   */
  | { kind: 'submit'; line: string; saveName?: NamingState }
  /**
   * ^X on a surfaced magic name: delete the handle of `line` without
   * executing anything — the prompt stays open. Persistence (tombstone)
   * happens outside; `state` continues the prompt with the selection reset.
   */
  | { kind: 'forget'; line: string; state: PromptState }
  /**
   * ^S in the naming badge: persist the handle on its scope WITHOUT executing
   * the command — the mirror image of 'forget'. Needed because switching an
   * existing handle to global would otherwise have to run the command.
   * Persistence happens outside; `state` continues the prompt with the badge
   * closed.
   */
  | { kind: 'name'; line: string; saveName: NamingState; state: PromptState }
  /**
   * ^X on a history suggestion (selected dropdown row or Ctrl-R hit): remove
   * `line` from the history — every occurrence, or it resurfaces at once.
   * Persistence and the model rebuild happen outside, like 'forget'.
   */
  | { kind: 'forget-history'; line: string; state: PromptState }
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
  // Magic resolution is all-or-nothing: a partial chunk would splice the
  // resolved command mid-word — → accepts the whole resolution like Tab.
  if (candidate.source === 'magic') return acceptSelected(state, ctx);
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

/** Handles blocking this level, minus the one already owned by this line
 *  (renaming to itself is not a collision). */
function blockingFor(state: PromptState, ctx: HandlerContext, scope: NameScope): string[] {
  const own = ctx.names?.handleFor(state.line.trim(), ctx.cwd ?? '') ?? null;
  return (ctx.names?.blockingHandles(scope, ctx.cwd ?? '') ?? []).filter((handle) => handle !== own);
}

export function handleKey(state: PromptState, event: KeyEvent, ctx: HandlerContext): KeyOutcome {
  const { input, key } = event;

  // --- Paste mode — a multiline block is pending, completion is bypassed.
  // Enter runs it verbatim, Esc/Ctrl-C discards it (the typed line survives),
  // everything else is swallowed: the block is not editable by design. ---
  if (state.pasted !== null) {
    if (key.return) return { kind: 'submit', line: state.pasted };
    if (key.escape || (key.ctrl && input === 'c')) return update({ ...state, pasted: null });
    return update(state);
  }

  // --- Naming badge (Ctrl+N) — the command line is frozen, only the handle
  // is edited. Dropdown navigation, history and Ctrl-R are disabled here. ---
  if (state.naming !== null) {
    const { handle, scope } = state.naming;
    if (key.escape || (key.ctrl && input === 'c')) {
      return update({ ...state, naming: null });
    }
    // ^G: same handle, other level. The badge recomputes its collision hint,
    // so a red "taken" can resolve by switching levels.
    if (key.ctrl && input === 'g') {
      return update({ ...state, naming: { handle, scope: scope === 'here' ? 'global' : 'here' } });
    }
    if (key.return) {
      // Enter never blocks: a valid handle saves, an empty badge signals
      // delete-if-named, anything invalid just executes without saving
      // (the badge already showed red beforehand).
      if (handle === '') return { kind: 'submit', line: state.line, saveName: { handle: '', scope } };
      const valid = validateHandle(handle, state.line, blockingFor(state, ctx, scope));
      return valid !== null
        ? { kind: 'submit', line: state.line, saveName: { handle: valid, scope } }
        : { kind: 'submit', line: state.line };
    }
    if (key.ctrl && input === 's') {
      // An empty badge means "drop the name" — that is exactly what ^X does,
      // so reuse its outcome instead of building a second delete path.
      if (handle === '') {
        return ctx.names?.has(state.line.trim()) === true
          ? { kind: 'forget', line: state.line.trim(), state: { ...state, naming: null, selected: 0 } }
          : update({ ...state, naming: null });
      }
      const valid = validateHandle(handle, state.line, blockingFor(state, ctx, scope));
      // Nothing executes here, so an invalid handle must not vanish silently:
      // keep the badge open with its red hint.
      return valid === null
        ? update(state)
        : { kind: 'name', line: state.line, saveName: { handle: valid, scope }, state: { ...state, naming: null } };
    }
    if (key.ctrl && input === 'u') return update({ ...state, naming: { handle: '', scope } });
    if (key.backspace || key.delete) {
      return update({ ...state, naming: { handle: handle.slice(0, -1), scope } });
    }
    if (input && !key.ctrl && !key.meta) {
      // Live filter: only a-z / 0-9 enter the badge (letters lowercased),
      // everything else is swallowed — the badge always holds a form-valid
      // handle-in-progress. Length is capped at 16.
      const filtered = input.toLowerCase().replace(/[^a-z0-9]/g, '');
      return update({ ...state, naming: { handle: (handle + filtered).slice(0, 16), scope } });
    }
    return update(state);
  }

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
    // ^X on a hit: forget it right where it turned up. Search results ARE
    // whole history lines, so this is the one place no accepted-line
    // arithmetic is needed. The mode stays open — the list refreshes without it.
    if (key.ctrl && input === 'x') {
      const picked = ctx.searchResults[state.searchSelected];
      if (picked === undefined) return update(state);
      return { kind: 'forget-history', line: picked, state: { ...state, searchSelected: 0 } };
    }
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
  if (key.ctrl && input === 'n') {
    // Name this command. Only for real, non-empty commands (':help' etc. are
    // not executable) and only with an index wired up (feature toggle).
    // A command that already has a handle gets it prefilled for edit/overwrite.
    if (ctx.names === undefined || state.line.trim() === '' || state.line.trimStart().startsWith(':')) {
      return update(state);
    }
    const existing = ctx.names.nameFor(state.line.trim(), ctx.cwd ?? '');
    return update({
      ...state,
      naming: existing === null ? { handle: '', scope: 'here' } : { handle: existing.name, scope: scopeOf(existing) },
    });
  }
  if (key.ctrl && input === 'x') {
    // Forget the selected suggestion right where it gets in the way. Nothing
    // executes — the prompt keeps the typed line. Three targets, in order:
    // a ⚡ candidate loses its magic name, the typed line's own handle
    // (discovery badge) likewise, and a history candidate is removed from the
    // history itself.
    const candidate = ctx.candidates[clampedSelected(state, ctx)];
    if (ctx.names !== undefined) {
      if (state.dropdownVisible && candidate?.source === 'magic') {
        return { kind: 'forget', line: candidate.display, state: { ...state, selected: 0 } };
      }
      if (ctx.names.handleFor(state.line.trim(), ctx.cwd ?? '') !== null) {
        return { kind: 'forget', line: state.line.trim(), state: { ...state, selected: 0 } };
      }
    }
    if (state.dropdownVisible && candidate && (candidate.source === 'history' || candidate.source === 'both')) {
      // The candidate may be a merged stem ("npm ") rather than a full
      // command. Forgetting targets what accepting would put on the line —
      // and only when that is a real history line, so ^X on a stem stays a
      // no-op instead of pretending to delete something that is not there.
      const replaceFrom = state.cursor - (candidate.replacePrefixLength ?? ctx.prefix.length);
      const target = (
        state.line.slice(0, Math.max(0, replaceFrom)) + candidate.display + state.line.slice(state.cursor)
      ).trim();
      if (ctx.recentUnique.includes(target)) {
        return { kind: 'forget-history', line: target, state: { ...state, selected: 0 } };
      }
    }
    return update(state);
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

  if (key.return) {
    // Enter on a deliberately navigated dropdown selection accepts that
    // candidate instead of submitting the half-typed line. selected > 0 is
    // only reachable via ↑/↓ in the dropdown with nothing typed since (withLine
    // resets selected to 0 on every edit), so this never hijacks a normal
    // type→Enter. Two-stage by design: acceptSelected fills the line and resets
    // selected, so a second Enter submits the completed command.
    const selectedIndex = clampedSelected(state, ctx);
    const candidate = ctx.candidates[selectedIndex];
    if (state.dropdownVisible && selectedIndex > 0 && candidate && candidate.insert !== '') {
      return update(acceptSelected(state, ctx));
    }
    // Exact magic handle = one-step fast path: Enter submits the resolved
    // command directly. Only a whole-line exact match resolves — a handle
    // with arguments appended is not a handle anymore.
    const resolved = ctx.names?.resolve(state.line.trim(), ctx.cwd ?? '') ?? null;
    return { kind: 'submit', line: resolved ?? state.line };
  }

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
  // - Empty line at rest: ↑ goes back into history (last command, failed ones
  //   included) like a standard shell; ↓ scrolls into the frecency dropdown so
  //   the suggestions can be explored. Tab still accepts the top candidate.
  // - Non-empty line, dropdown at rest (selected === 0): ↑ starts a fish-style
  //   substring search through history.
  // - While scrolling the dropdown (selected > 0): ↑/↓ move the selection
  //   symmetrically and never hijack into history mid-scroll.
  // Esc hides the dropdown -> history gets through.
  if (key.upArrow) {
    // fish-style substring search: non-empty line + dropdown at rest starts the
    // search. Skipped once the list is being scrolled (selected > 0) so ↑ walks
    // back up the list. startSubstringSearch returns state unchanged when there
    // are no hits — then it falls into the dropdown cycle below.
    if (
      state.line !== '' &&
      state.dropdownVisible &&
      state.selected === 0 &&
      state.historyFilter === null &&
      state.historyIndex === null
    ) {
      const started = startSubstringSearch(state, ctx);
      if (started !== state) return update(started);
      // No history match: ↑ sits at the top of the dropdown (selected === 0)
      // with nowhere to go. Hold instead of wrapping the selection around to
      // the last candidate — that jump made the same keypress unpredictable.
      // With no candidates the block below still falls through to history.
      if (ctx.candidates.length > 0) return update(state);
    }
    if (state.historyFilter !== null) {
      return update(navigateSubstring(state, -1, ctx));
    }
    // History on ↑ when: already paging history, no dropdown to move through, or
    // an empty line at rest — then ↑ goes back to the last command like a shell.
    // While scrolling the dropdown (selected > 0) ↑ walks the list back up.
    if (
      state.historyIndex !== null ||
      !state.dropdownVisible ||
      ctx.candidates.length === 0 ||
      (state.line === '' && state.selected === 0)
    ) {
      return update(navigateHistory(state, -1, ctx));
    }
    return update({ ...state, selected: (clampedSelected(state, ctx) - 1 + ctx.candidates.length) % ctx.candidates.length });
  }
  if (key.downArrow) {
    if (state.historyFilter !== null) {
      return update(navigateSubstring(state, 1, ctx));
    }
    // ↓ moves through the dropdown whenever one is visible — including on an
    // empty line, so the frecency suggestions can be explored. History only when
    // already paging it or when there is no dropdown to move through.
    if (state.historyIndex !== null || !state.dropdownVisible || ctx.candidates.length === 0) {
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
