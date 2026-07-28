import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTINGS, specFor } from '../../src/settings/schema.js';

/**
 * gui/boot-defaults.json is the cross-language parity fixture: the overlay
 * needs gui.launcherWidth and gui.hotkey BEFORE it can reach the daemon, so
 * BootSettings.swift carries its own copies of those defaults. This test pins
 * the fixture to the TypeScript schema; the pinned `bootDefaults` table in
 * Check.swift pins the Swift side to the same file. Drift on either side goes
 * red instead of shipping two different defaults.
 */
describe('boot-defaults fixture', () => {
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../gui/boot-defaults.json', import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;

  it('matches the schema defaults for every boot-path key', () => {
    expect(fixture).toEqual({
      'gui.launcherWidth': specFor('gui.launcherWidth')?.default,
      'gui.hotkey': specFor('gui.hotkey')?.default,
    });
  });

  it('every fixture key exists in the schema', () => {
    for (const key of Object.keys(fixture)) {
      expect(SETTINGS.map((spec) => spec.key), key).toContain(key);
    }
  });
});
