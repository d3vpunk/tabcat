import { SETTINGS, SettingSpec, SettingValue, parseInput } from '../settings/schema.js';
import { SettingsRead } from '../settings/store.js';

/**
 * Pure state machine of the interactive settings editor — the Ink component
 * (settings-ui.tsx) only holds state, renders and performs the effects. Same
 * split as prompt-state.ts, and for the same reason: every rule is testable
 * without a terminal.
 */

export interface SettingsUiState {
  /** Injectable for tests; defaults to the real schema. Row order = spec order. */
  readonly specs: readonly SettingSpec[];
  readonly values: ReadonlyMap<string, SettingValue>;
  readonly overridden: ReadonlySet<string>;
  readonly selected: number;
  /** null = navigating; otherwise the edit buffer of the selected string row. */
  readonly editing: string | null;
  readonly error: string | null;
  readonly done: boolean;
}

export interface SettingsUiKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
}

/**
 * The reducer stays pure: it reports what should hit the disk, the component
 * executes it. State is already advanced optimistically — on a failed write
 * the component falls back to what the file really says.
 */
export type SettingsUiEffect = { kind: 'write'; key: string; value: SettingValue } | { kind: 'clear'; key: string };

export interface SettingsUiOutcome {
  state: SettingsUiState;
  effect?: SettingsUiEffect;
}

export function initialSettingsUiState(read: SettingsRead, specs: readonly SettingSpec[] = SETTINGS): SettingsUiState {
  return {
    specs,
    values: read.values,
    overridden: read.overridden,
    selected: 0,
    editing: null,
    error: null,
    done: false,
  };
}

export function handleSettingsUiKey(state: SettingsUiState, input: string, key: SettingsUiKey): SettingsUiOutcome {
  // Ctrl+C leaves immediately, even mid-edit — the REPL loop resumes.
  if (key.ctrl === true && input === 'c') return { state: { ...state, done: true } };
  // Any key acknowledges a shown error; an edit-commit error re-sets it below.
  const base = state.error === null ? state : { ...state, error: null };
  const spec = base.specs[base.selected];
  if (spec === undefined) {
    return key.escape === true ? { state: { ...base, done: true } } : { state: base };
  }
  if (base.editing !== null) return handleEditKey(base, spec, input, key);

  if (key.escape === true) return { state: { ...base, done: true } };
  if (key.upArrow === true) return { state: { ...base, selected: Math.max(0, base.selected - 1) } };
  if (key.downArrow === true) return { state: { ...base, selected: Math.min(base.specs.length - 1, base.selected + 1) } };
  if (key.backspace === true || key.delete === true) {
    // Reset = remove the override. Nothing to remove on a default row.
    if (!base.overridden.has(spec.key)) return { state: base };
    return clear(base, spec);
  }

  switch (spec.type) {
    case 'bool': {
      if (key.return === true || input === ' ') return write(base, spec, base.values.get(spec.key) !== true);
      return { state: base };
    }
    case 'int': {
      const direction = key.rightArrow === true ? 1 : key.leftArrow === true ? -1 : 0;
      if (direction === 0) return { state: base };
      const current = base.values.get(spec.key) as number;
      const next = Math.min(spec.max, Math.max(spec.min, current + direction * (spec.step ?? 1)));
      // At the bounds the key does nothing — no write, no flicker.
      if (next === current) return { state: base };
      return write(base, spec, next);
    }
    case 'enum': {
      const direction = key.rightArrow === true ? 1 : key.leftArrow === true ? -1 : 0;
      if (direction === 0) return { state: base };
      const index = spec.options.indexOf(base.values.get(spec.key) as string);
      const next = spec.options[(index + direction + spec.options.length) % spec.options.length] as string;
      return write(base, spec, next);
    }
    case 'string': {
      if (key.return === true) return { state: { ...base, editing: String(base.values.get(spec.key)) } };
      return { state: base };
    }
  }
}

function handleEditKey(state: SettingsUiState, spec: SettingSpec, input: string, key: SettingsUiKey): SettingsUiOutcome {
  const buffer = state.editing ?? '';
  if (key.escape === true) return { state: { ...state, editing: null } };
  if (key.return === true) {
    const parsed = parseInput(spec, buffer);
    // Invalid input keeps the buffer open — correct it or escape out.
    if (!parsed.ok) return { state: { ...state, error: `${spec.key}: ${parsed.error}` } };
    return write({ ...state, editing: null }, spec, parsed.value);
  }
  if (key.backspace === true || key.delete === true) return { state: { ...state, editing: buffer.slice(0, -1) } };
  const isArrow = key.upArrow === true || key.downArrow === true || key.leftArrow === true || key.rightArrow === true;
  if (input !== '' && !isArrow && key.ctrl !== true) return { state: { ...state, editing: buffer + input } };
  return { state };
}

function write(state: SettingsUiState, spec: SettingSpec, value: SettingValue): SettingsUiOutcome {
  const values = new Map(state.values);
  values.set(spec.key, value);
  const overridden = new Set(state.overridden);
  overridden.add(spec.key);
  return { state: { ...state, values, overridden }, effect: { kind: 'write', key: spec.key, value } };
}

function clear(state: SettingsUiState, spec: SettingSpec): SettingsUiOutcome {
  const values = new Map(state.values);
  values.set(spec.key, spec.default);
  const overridden = new Set(state.overridden);
  overridden.delete(spec.key);
  return { state: { ...state, values, overridden }, effect: { kind: 'clear', key: spec.key } };
}
