import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every .ts/.tsx file under src/, recursively. */
function sources(dir = 'src'): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/**
 * `cwds` is an implementation detail of the names module: `specificityOf` /
 * `activeIn` answer "does this apply here?", `makeName` / `appendTombstone`
 * construct records. Two hand-built copies of the predicate had already
 * drifted into run.ts and engine-host.ts before this guard existed.
 *
 * Two forbidden shapes, matched precisely so the daemon's unrelated `cwds`
 * op (working directories by frecency) stays legal: reading the field
 * (`name.cwds.length`) and building the array (`cwds: [cwd]`).
 * `host.cwds(limit)` and `cwds: 4` must NOT match.
 */
describe('names: cwds stays encapsulated', () => {
  const OWNERS = ['src/engine/names.ts', 'src/engine/names-store.ts'];
  const readsField = /\.cwds\b(?!\s*\()/;
  const buildsArray = /\bcwds\s*:\s*\[/;

  it('no file outside the names module reads or builds cwds', () => {
    const offenders = sources()
      .filter((file) => !OWNERS.includes(file))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return readsField.test(text) || buildsArray.test(text);
      });

    expect(offenders).toEqual([]);
  });
});
