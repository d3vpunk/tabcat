import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  files?: string[];
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
}

const manifest: PackageManifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

describe('npm package', () => {
  it('rebuilds dist before every pack and publish', () => {
    expect(manifest.scripts?.['prepack']).toBe('npm run build');
  });

  it('publishes only built runtime files and documentation', () => {
    expect(manifest.files).toEqual(['dist/', 'README.md', 'LICENSE']);
  });

  it('copies the zsh plugin into dist on every build', () => {
    // tsc only emits JavaScript, so without this step `tabcat plugin init zsh`
    // would point at a file that is not in the published package.
    expect(manifest.scripts?.['build']).toContain('copy-assets');
  });

  it('links tabcat to the built CLI entry point', () => {
    expect(manifest.bin?.['tabcat']).toBe('dist/cli.js');
    expect(readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8')).toMatch(/^#!\/usr\/bin\/env node/);
  });
});
