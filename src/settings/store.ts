import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireLock, defaultHistoryFile } from '../engine/store.js';
import { SETTINGS, SettingValue, specFor, validateValue } from './schema.js';

/**
 * settings.json is SPARSE: it holds only deviations from the defaults, which
 * live in the schema. A missing key is the default, a missing file is all
 * defaults — and resetting a setting DELETES its key instead of writing the
 * default back, so a future default change still reaches every user who
 * never chose a value.
 */

export function settingsFileFor(historyFile: string): string {
  return join(dirname(historyFile), 'settings.json');
}

export function defaultSettingsFile(): string {
  return settingsFileFor(defaultHistoryFile());
}

export interface SettingsRead {
  /** Effective value for every known key: defaults overlaid with the file. */
  readonly values: ReadonlyMap<string, SettingValue>;
  /** Keys whose value came from the file — only these have a "reset". */
  readonly overridden: ReadonlySet<string>;
  /** Unknown keys, invalid values, unreadable file. Callers decide how to surface them. */
  readonly warnings: readonly string[];
}

/**
 * Never throws: a hand-edited file with a typo must not take the REPL or the
 * daemon down. Broken JSON reads as all defaults plus a warning; writing to
 * such a file is refused (see writeSetting).
 */
export function readSettings(file: string = defaultSettingsFile()): SettingsRead {
  const values = new Map<string, SettingValue>(SETTINGS.map((spec) => [spec.key, spec.default]));
  const overridden = new Set<string>();
  const warnings: string[] = [];
  const root = readRoot(file, warnings);
  if (root !== null) {
    collect(root, '', values, overridden, warnings);
  }
  return { values, overridden, warnings };
}

/** Effective value with the type the schema promises; throws on a key the schema does not know (programmer error). */
export function boolSetting(settings: SettingsRead, key: string): boolean {
  return typedValue(settings, key, 'boolean') as boolean;
}

export function intSetting(settings: SettingsRead, key: string): number {
  return typedValue(settings, key, 'number') as number;
}

export function stringSetting(settings: SettingsRead, key: string): string {
  return typedValue(settings, key, 'string') as string;
}

/**
 * Validates against the schema, then mutates the RAW parsed file under the
 * shared lock: keys this version does not know survive untouched — an older
 * tabcat must never strip what a newer one wrote. Refuses to write over a
 * file that is not valid JSON instead of clobbering a hand-edit.
 */
export function writeSetting(file: string, key: string, value: SettingValue): void {
  const spec = specFor(key);
  if (spec === undefined) throw new Error(`unknown setting: ${key}`);
  const checked = validateValue(spec, value);
  if (!checked.ok) throw new Error(`${key}: ${checked.error}`);
  mutate(file, (root) => {
    // Normalize: a flat spelling at the root ("repl.footer": …) means the
    // same key; drop it so the nested write does not leave a duplicate.
    delete root[key];
    const segments = key.split('.');
    const leaf = segments.pop() as string;
    let node = root;
    for (const segment of segments) {
      const next = node[segment];
      if (!isPlainObject(next)) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    node[leaf] = checked.value;
  });
}

/** Removes the override (nested and flat spelling) and prunes emptied sections. */
export function clearSetting(file: string, key: string): void {
  if (specFor(key) === undefined) throw new Error(`unknown setting: ${key}`);
  if (!existsSync(file)) return;
  mutate(file, (root) => {
    delete root[key];
    removeNested(root, key.split('.'));
  });
}

function typedValue(settings: SettingsRead, key: string, expected: 'boolean' | 'number' | 'string'): SettingValue {
  const value = settings.values.get(key);
  if (value === undefined || typeof value !== expected) {
    throw new Error(`setting ${key} is not a known ${expected} setting`);
  }
  return value;
}

function readRoot(file: string, warnings: string[]): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isPlainObject(parsed)) return parsed;
    warnings.push(`settings: ${file} is not a JSON object — using defaults`);
  } catch {
    warnings.push(`settings: ${file} is not valid JSON — using defaults`);
  }
  return null;
}

/**
 * Depth-first walk that flattens nested sections to dotted keys. A dotted key
 * spelled flat in the file falls out of the same walk for free. Descends only
 * into objects the schema does not claim as a value, so an object where a
 * value belongs reports as invalid instead of spawning ghost keys.
 */
function collect(
  node: Record<string, unknown>,
  prefix: string,
  values: Map<string, SettingValue>,
  overridden: Set<string>,
  warnings: string[],
): void {
  for (const [name, raw] of Object.entries(node)) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    const spec = specFor(path);
    if (spec !== undefined) {
      const checked = validateValue(spec, raw);
      if (checked.ok) {
        values.set(path, checked.value);
        overridden.add(path);
      } else {
        warnings.push(`settings: ${path}: ${checked.error} — using default`);
      }
    } else if (isPlainObject(raw)) {
      collect(raw, path, values, overridden, warnings);
    } else {
      warnings.push(`settings: unknown key ${path} — ignored`);
    }
  }
}

function mutate(file: string, change: (root: Record<string, unknown>) => void): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const release = acquireLock(file, 2_000);
  if (!release) throw new Error(`Could not acquire settings lock: ${file}`);
  try {
    let root: Record<string, unknown> = {};
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isPlainObject(parsed)) throw new Error('not a JSON object');
      root = parsed;
    }
    change(root);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(root, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'not a JSON object')) {
      throw new Error(`settings: ${file} is not valid JSON — fix or delete it before writing`);
    }
    throw error;
  } finally {
    release();
  }
}

/** Deletes the leaf at the path and prunes every section it empties. */
function removeNested(node: Record<string, unknown>, segments: readonly string[]): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (rest.length === 0) {
    delete node[head];
  } else {
    const child = node[head];
    if (!isPlainObject(child)) return;
    removeNested(child, rest);
    if (Object.keys(child).length === 0) delete node[head];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
