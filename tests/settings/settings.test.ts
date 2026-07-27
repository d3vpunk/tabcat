import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, parseInput, specFor, validateValue } from '../../src/settings/schema.js';
import {
  boolSetting,
  clearSetting,
  intSetting,
  readSettings,
  settingsFileFor,
  writeSetting,
} from '../../src/settings/store.js';

const raw = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

describe('settings schema', () => {
  it('every default passes its own validation — pins each future entry', () => {
    for (const spec of SETTINGS) {
      expect(validateValue(spec, spec.default), spec.key).toEqual({ ok: true, value: spec.default });
    }
  });

  it('keys are unique and follow <surface>.<name>', () => {
    const keys = SETTINGS.map((spec) => spec.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z]+\.[a-zA-Z.]+$/);
  });

  it('validates ints against their range', () => {
    const spec = specFor('repl.dropdownRows')!;
    expect(validateValue(spec, 5)).toEqual({ ok: true, value: 5 });
    expect(validateValue(spec, 0).ok).toBe(false);
    expect(validateValue(spec, 21).ok).toBe(false);
    expect(validateValue(spec, 5.5).ok).toBe(false);
    expect(validateValue(spec, '5').ok).toBe(false);
  });

  it('validates bools strictly', () => {
    const spec = specFor('repl.footer')!;
    expect(validateValue(spec, false)).toEqual({ ok: true, value: false });
    expect(validateValue(spec, 'false').ok).toBe(false);
    expect(validateValue(spec, 0).ok).toBe(false);
  });

  it('parses typed CLI input, strictly', () => {
    const rows = specFor('repl.dropdownRows')!;
    const footer = specFor('repl.footer')!;
    expect(parseInput(rows, '8')).toEqual({ ok: true, value: 8 });
    expect(parseInput(rows, 'eight').ok).toBe(false);
    expect(parseInput(rows, '8.5').ok).toBe(false);
    expect(parseInput(footer, 'true')).toEqual({ ok: true, value: true });
    expect(parseInput(footer, 'yes').ok).toBe(false);
    expect(parseInput(footer, 'TRUE').ok).toBe(false);
  });

  it('error messages name the expectation', () => {
    const result = validateValue(specFor('repl.dropdownRows')!, 99);
    expect(result).toEqual({ ok: false, error: 'expected an integer between 1 and 20' });
  });
});

describe('settings store', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tabcat-settings-'));
    file = join(dir, 'settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('settingsFileFor is a sibling of the history file', () => {
    expect(settingsFileFor('/home/dev/.config/tabcat/history.jsonl')).toBe('/home/dev/.config/tabcat/settings.json');
  });

  it('missing file reads as all defaults, nothing overridden', () => {
    const settings = readSettings(file);
    expect(intSetting(settings, 'repl.dropdownRows')).toBe(5);
    expect(boolSetting(settings, 'repl.footer')).toBe(true);
    expect(settings.overridden.size).toBe(0);
    expect(settings.warnings).toEqual([]);
  });

  it('write/read round-trip marks the key as overridden', () => {
    writeSetting(file, 'repl.dropdownRows', 8);
    const settings = readSettings(file);
    expect(intSetting(settings, 'repl.dropdownRows')).toBe(8);
    expect(settings.overridden).toEqual(new Set(['repl.dropdownRows']));
    expect(boolSetting(settings, 'repl.footer')).toBe(true); // untouched default
  });

  it('the file stays sparse: only the written key, nested', () => {
    writeSetting(file, 'repl.footer', false);
    expect(raw(file)).toEqual({ repl: { footer: false } });
  });

  it('reset deletes the key and prunes the emptied section', () => {
    writeSetting(file, 'repl.footer', false);
    clearSetting(file, 'repl.footer');
    expect(raw(file)).toEqual({});
    expect(boolSetting(readSettings(file), 'repl.footer')).toBe(true);
  });

  it('reset keeps siblings and unknown keys intact', () => {
    writeFileSync(file, JSON.stringify({ repl: { footer: false, dropdownRows: 9 }, future: { thing: 1 } }));
    clearSetting(file, 'repl.footer');
    expect(raw(file)).toEqual({ repl: { dropdownRows: 9 }, future: { thing: 1 } });
  });

  it('clearSetting on a missing file is a no-op', () => {
    expect(() => clearSetting(file, 'repl.footer')).not.toThrow();
  });

  it('unknown keys warn and survive a write untouched', () => {
    writeFileSync(file, JSON.stringify({ future: { thing: true }, repl: { footer: false } }));
    const settings = readSettings(file);
    expect(settings.warnings).toEqual(['settings: unknown key future.thing — ignored']);
    expect(boolSetting(settings, 'repl.footer')).toBe(false);

    writeSetting(file, 'repl.dropdownRows', 3);
    expect(raw(file)).toEqual({ future: { thing: true }, repl: { footer: false, dropdownRows: 3 } });
  });

  it('an invalid value warns and falls back to the default', () => {
    writeFileSync(file, JSON.stringify({ repl: { dropdownRows: 999 } }));
    const settings = readSettings(file);
    expect(intSetting(settings, 'repl.dropdownRows')).toBe(5);
    expect(settings.overridden.size).toBe(0);
    expect(settings.warnings).toEqual([
      'settings: repl.dropdownRows: expected an integer between 1 and 20 — using default',
    ]);
  });

  it('an object where a value belongs is invalid, not a source of ghost keys', () => {
    writeFileSync(file, JSON.stringify({ repl: { dropdownRows: { nested: 3 } } }));
    const settings = readSettings(file);
    expect(intSetting(settings, 'repl.dropdownRows')).toBe(5);
    expect(settings.warnings).toHaveLength(1);
    expect(settings.warnings[0]).toContain('repl.dropdownRows');
  });

  it('a flat dotted key reads as the same setting', () => {
    writeFileSync(file, JSON.stringify({ 'repl.footer': false }));
    const settings = readSettings(file);
    expect(boolSetting(settings, 'repl.footer')).toBe(false);
    expect(settings.overridden).toEqual(new Set(['repl.footer']));
  });

  it('writing normalizes a flat spelling to nested without leaving a duplicate', () => {
    writeFileSync(file, JSON.stringify({ 'repl.footer': false }));
    writeSetting(file, 'repl.footer', true);
    expect(raw(file)).toEqual({ repl: { footer: true } });
  });

  it('broken JSON reads as defaults with a warning', () => {
    writeFileSync(file, '{ not json');
    const settings = readSettings(file);
    expect(intSetting(settings, 'repl.dropdownRows')).toBe(5);
    expect(settings.warnings).toEqual([`settings: ${file} is not valid JSON — using defaults`]);
  });

  it('refuses to write over broken JSON instead of clobbering a hand-edit', () => {
    writeFileSync(file, '{ not json');
    expect(() => writeSetting(file, 'repl.footer', false)).toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ not json'); // untouched
  });

  it('a non-object root reads as defaults and refuses writes', () => {
    writeFileSync(file, JSON.stringify([1, 2, 3]));
    expect(readSettings(file).warnings).toEqual([`settings: ${file} is not a JSON object — using defaults`]);
    expect(() => writeSetting(file, 'repl.footer', false)).toThrow(/not valid JSON/);
  });

  it('writeSetting rejects invalid values and unknown keys before touching the file', () => {
    expect(() => writeSetting(file, 'repl.dropdownRows', 999)).toThrow(/between 1 and 20/);
    expect(() => writeSetting(file, 'no.such', 1)).toThrow(/unknown setting/);
    expect(() => clearSetting(file, 'no.such')).toThrow(/unknown setting/);
    expect(readSettings(file).overridden.size).toBe(0);
  });

  it('typed getters throw on schema misuse (programmer error)', () => {
    const settings = readSettings(file);
    expect(() => intSetting(settings, 'repl.footer')).toThrow();
    expect(() => boolSetting(settings, 'no.such')).toThrow();
  });

  it('the written file is private (0600)', () => {
    writeSetting(file, 'repl.footer', false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
