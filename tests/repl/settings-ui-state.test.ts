import { describe, expect, it } from 'vitest';
import { SettingSpec } from '../../src/settings/schema.js';
import { readSettings } from '../../src/settings/store.js';
import {
  SettingsUiKey,
  SettingsUiOutcome,
  SettingsUiState,
  handleSettingsUiKey,
  initialSettingsUiState,
} from '../../src/repl/settings-ui-state.js';

const SPECS: readonly SettingSpec[] = [
  { key: 'repl.dropdownRows', type: 'int', default: 5, min: 1, max: 20, label: 'Rows', description: 'rows', appliesLive: true },
  { key: 'repl.footer', type: 'bool', default: true, label: 'Footer', description: 'footer', appliesLive: true },
  { key: 'gui.theme', type: 'enum', default: 'auto', options: ['auto', 'light', 'dark'], label: 'Theme', description: 'theme', appliesLive: true },
  { key: 'gui.hotkey', type: 'hotkey', default: 'opt space', label: 'Hotkey', description: 'hotkey', appliesLive: false },
];

/** Editor state over the fake schema, all defaults — tests never touch a real file. */
const fresh = (): SettingsUiState =>
  initialSettingsUiState({ values: new Map(SPECS.map((s) => [s.key, s.default])), overridden: new Set(), warnings: [] }, SPECS);

const press = (state: SettingsUiState, key: SettingsUiKey, input = ''): SettingsUiOutcome =>
  handleSettingsUiKey(state, input, key);

const at = (state: SettingsUiState, index: number): SettingsUiState => ({ ...state, selected: index });

describe('settings editor state machine', () => {
  it('initial state mirrors a SettingsRead and defaults to the real schema', () => {
    const read = readSettings('/nonexistent/settings.json');
    const state = initialSettingsUiState(read);
    expect(state.specs.length).toBeGreaterThan(0);
    expect(state.values.get('repl.dropdownRows')).toBe(5);
    expect(state.selected).toBe(0);
  });

  it('↑/↓ move the selection and clamp at both ends', () => {
    let state = fresh();
    expect(press(state, { upArrow: true }).state.selected).toBe(0);
    state = press(state, { downArrow: true }).state;
    state = press(state, { downArrow: true }).state;
    expect(state.selected).toBe(2);
    state = at(state, SPECS.length - 1);
    expect(press(state, { downArrow: true }).state.selected).toBe(SPECS.length - 1);
  });

  it('esc closes, ctrl+c closes even mid-edit', () => {
    expect(press(fresh(), { escape: true }).state.done).toBe(true);
    const editing = { ...at(fresh(), 3), editing: 'opt' };
    expect(press(editing, { ctrl: true }, 'c').state.done).toBe(true);
  });

  it('space and enter toggle a bool and emit a write', () => {
    const state = at(fresh(), 1);
    const toggled = press(state, {}, ' ');
    expect(toggled.effect).toEqual({ kind: 'write', key: 'repl.footer', value: false });
    expect(toggled.state.values.get('repl.footer')).toBe(false);
    expect(toggled.state.overridden.has('repl.footer')).toBe(true);
    const back = press(toggled.state, { return: true });
    expect(back.effect).toEqual({ kind: 'write', key: 'repl.footer', value: true });
  });

  it('←/→ step an int and stay silent at the bounds', () => {
    let state = fresh();
    const up = press(state, { rightArrow: true });
    expect(up.effect).toEqual({ kind: 'write', key: 'repl.dropdownRows', value: 6 });
    const down = press(state, { leftArrow: true });
    expect(down.effect).toEqual({ kind: 'write', key: 'repl.dropdownRows', value: 4 });

    state = { ...state, values: new Map(state.values).set('repl.dropdownRows', 20) };
    const atMax = press(state, { rightArrow: true });
    expect(atMax.effect).toBeUndefined();
    expect(atMax.state.values.get('repl.dropdownRows')).toBe(20);
  });

  it('←/→ cycle an enum and wrap around', () => {
    const state = at(fresh(), 2);
    const right = press(state, { rightArrow: true });
    expect(right.effect).toEqual({ kind: 'write', key: 'gui.theme', value: 'light' });
    const left = press(state, { leftArrow: true }); // wraps from 'auto' to the end
    expect(left.effect).toEqual({ kind: 'write', key: 'gui.theme', value: 'dark' });
  });

  it('backspace resets only an overridden row', () => {
    const untouched = press(at(fresh(), 1), { backspace: true });
    expect(untouched.effect).toBeUndefined();

    const overridden = press(at(fresh(), 1), {}, ' ').state; // footer -> false
    const reset = press(overridden, { delete: true });
    expect(reset.effect).toEqual({ kind: 'clear', key: 'repl.footer' });
    expect(reset.state.values.get('repl.footer')).toBe(true);
    expect(reset.state.overridden.has('repl.footer')).toBe(false);
  });

  it('a string row edits inline: open, type, commit', () => {
    let state = at(fresh(), 3);
    state = press(state, { return: true }).state;
    expect(state.editing).toBe('opt space'); // buffer starts at the current value
    state = press(state, { backspace: true }).state;
    expect(state.editing).toBe('opt spac');
    state = press(state, {}, 'e').state;
    const committed = press(state, { return: true });
    expect(committed.effect).toEqual({ kind: 'write', key: 'gui.hotkey', value: 'opt space' });
    expect(committed.state.editing).toBeNull();
  });

  it('esc cancels an edit without writing', () => {
    let state = press(at(fresh(), 3), { return: true }).state;
    state = press(state, {}, 'x').state;
    const cancelled = press(state, { escape: true });
    expect(cancelled.effect).toBeUndefined();
    expect(cancelled.state.editing).toBeNull();
    expect(cancelled.state.done).toBe(false);
    expect(cancelled.state.values.get('gui.hotkey')).toBe('opt space');
  });

  it('an invalid commit shows the expectation and keeps editing; the next key clears the error', () => {
    // string/hotkey accept everything today, so the failing validator is
    // pinned through a synthetic edit buffer on a bool spec — the rule must
    // hold for every future type that edits inline.
    const boolOnly: readonly SettingSpec[] = [SPECS[1] as SettingSpec];
    const base = initialSettingsUiState(
      { values: new Map([['repl.footer', true]]), overridden: new Set(), warnings: [] },
      boolOnly,
    );
    const failed = press({ ...base, editing: 'maybe' }, { return: true });
    expect(failed.effect).toBeUndefined();
    expect(failed.state.error).toBe('repl.footer: expected true or false');
    expect(failed.state.editing).toBe('maybe');
    const acknowledged = press(failed.state, {}, 'x');
    expect(acknowledged.state.error).toBeNull();
  });

  it('typing while navigating does nothing on non-bool rows', () => {
    const state = fresh();
    const typed = press(state, {}, 'x');
    expect(typed.effect).toBeUndefined();
    expect(typed.state).toEqual({ ...state, error: null });
  });
});
