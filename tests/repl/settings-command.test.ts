import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReplOutput, magicCommandHints } from '../../src/repl/app.js';
import { handleReplCommand } from '../../src/repl/run.js';
import { SETTINGS } from '../../src/settings/schema.js';
import { readSettings, settingsFileFor } from '../../src/settings/store.js';

describe(':settings command', () => {
  let dir: string;
  let historyFile: string;
  let settingsFile: string;
  let output: ReplOutput[];

  const context = () => ({
    cwd: '/work',
    historyFile,
    entries: [],
    showOutput: (value: ReplOutput) => output.push(value),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tabcat-repl-settings-'));
    historyFile = join(dir, 'history.jsonl');
    settingsFile = settingsFileFor(historyFile);
    output = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a bare :settings opens the interactive editor', () => {
    expect(handleReplCommand(':settings', context())).toBe('settings-ui');
    expect(output).toEqual([]);
  });

  it(':settings list shows every setting with value, default marker and description', () => {
    writeFileSync(settingsFile, JSON.stringify({ repl: { dropdownRows: 9 } }));
    expect(handleReplCommand(':settings list', context())).toBe('handled');
    const listed = output[0];
    if (listed?.kind !== 'settings') throw new Error('expected a settings output');
    expect(listed.rows.map((row) => row.key)).toEqual(SETTINGS.map((spec) => spec.key));
    const byKey = new Map(listed.rows.map((row) => [row.key, row]));
    expect(byKey.get('repl.dropdownRows')).toEqual({
      key: 'repl.dropdownRows',
      value: '9',
      isDefault: false,
      live: true,
      description: 'How many candidate rows the REPL dropdown shows at once.',
    });
    expect(byKey.get('repl.footer')).toEqual({
      key: 'repl.footer',
      value: 'true',
      isDefault: true,
      live: true,
      description: 'The key-hint line under the REPL prompt.',
    });
  });

  it('sets a value, persists it and notifies the loop', () => {
    let changed = 0;
    const result = handleReplCommand(':settings repl.dropdownRows 8', {
      ...context(),
      onSettingsChanged: () => changed++,
    });
    expect(result).toBe('handled');
    expect(changed).toBe(1);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ repl: { dropdownRows: 8 } });
    expect(output[0]).toEqual({ kind: 'note', title: 'settings', lines: ['repl.dropdownRows = 8'] });
  });

  it('shows a single setting with a default marker', () => {
    expect(handleReplCommand(':settings repl.footer', context())).toBe('handled');
    expect(output[0]).toMatchObject({ kind: 'note', lines: ['repl.footer = true (default)', expect.any(String)] });
  });

  it('resets a setting to its default', () => {
    writeFileSync(settingsFile, JSON.stringify({ repl: { footer: false } }));
    let changed = 0;
    expect(handleReplCommand(':settings reset repl.footer', { ...context(), onSettingsChanged: () => changed++ })).toBe('handled');
    expect(changed).toBe(1);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({});
    expect(output[0]).toEqual({ kind: 'note', title: 'settings', lines: ['repl.footer = true (default)'] });
    expect(readSettings(settingsFile).overridden.size).toBe(0);
  });

  it('rejects an invalid value with the expectation, file untouched', () => {
    let changed = 0;
    expect(handleReplCommand(':settings repl.dropdownRows 99', { ...context(), onSettingsChanged: () => changed++ })).toBe('handled');
    expect(changed).toBe(0);
    expect(output[0]).toEqual({
      kind: 'note',
      title: 'settings',
      lines: ['repl.dropdownRows: expected an integer between 1 and 20'],
      error: true,
    });
    expect(readSettings(settingsFile).overridden.size).toBe(0);
  });

  it('rejects unknown keys and malformed reset', () => {
    expect(handleReplCommand(':settings no.such 1', context())).toBe('handled');
    expect(handleReplCommand(':settings reset', context())).toBe('handled');
    expect(output[0]).toMatchObject({ kind: 'note', error: true, lines: ['unknown setting: no.such — :settings lists all keys'] });
    expect(output[1]).toMatchObject({ kind: 'note', error: true, lines: ['usage: :settings reset <key>'] });
  });

  it('refuses to write over broken JSON instead of clobbering it', () => {
    writeFileSync(settingsFile, '{ not json');
    expect(handleReplCommand(':settings repl.footer false', context())).toBe('handled');
    expect(output[0]).toMatchObject({ kind: 'note', error: true });
    expect(readFileSync(settingsFile, 'utf8')).toBe('{ not json');
  });

  it('arguments after other commands stay unhandled — no reinterpretation', () => {
    expect(handleReplCommand(':help now', context())).toBe('unhandled');
    expect(handleReplCommand(':history 5', context())).toBe('unhandled');
    expect(output).toEqual([]);
  });
});

describe(':settings completion hints', () => {
  it('completes keys and the reset verb after the command', () => {
    expect(magicCommandHints(':settings ')?.map(({ command }) => command)).toEqual([
      ':settings repl.plugins.git.enabled',
      ':settings repl.plugins.clock.enabled',
      ':settings repl.dropdownRows',
      ':settings repl.footer',
      ':settings gui.launcherWidth',
      ':settings gui.hotkey',
      ':settings reset',
    ]);
    expect(magicCommandHints(':settings repl.d')?.map(({ command }) => command)).toEqual([
      ':settings repl.dropdownRows',
    ]);
  });

  it('completes keys after reset', () => {
    expect(magicCommandHints(':settings reset ')?.map(({ command }) => command)).toEqual([
      ':settings reset repl.plugins.git.enabled',
      ':settings reset repl.plugins.clock.enabled',
      ':settings reset repl.dropdownRows',
      ':settings reset repl.footer',
      ':settings reset gui.launcherWidth',
      ':settings reset gui.hotkey',
    ]);
  });

  it('completes bool values, none for ints, none past the value', () => {
    expect(magicCommandHints(':settings repl.footer ')?.map(({ command }) => command)).toEqual([
      ':settings repl.footer true',
      ':settings repl.footer false',
    ]);
    expect(magicCommandHints(':settings repl.footer f')?.map(({ command }) => command)).toEqual([
      ':settings repl.footer false',
    ]);
    expect(magicCommandHints(':settings repl.dropdownRows ')).toEqual([]);
    expect(magicCommandHints(':settings repl.footer false ')).toEqual([]);
    expect(magicCommandHints(':settings no.such ')).toEqual([]);
  });

  it('a fully typed token is not offered as its own completion', () => {
    expect(magicCommandHints(':settings repl.footer')?.map(({ command }) => command)).toEqual([]);
  });

  it('preserves the typed spacing so candidates extend the line', () => {
    const hints = magicCommandHints(':settings  repl.f');
    expect(hints?.[0]?.command).toBe(':settings  repl.footer');
    expect(hints?.[0]?.command.startsWith(':settings  repl.f')).toBe(true);
  });
});
