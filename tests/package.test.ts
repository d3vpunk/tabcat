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
    expect(manifest.files).toEqual(['dist/', 'README.md']);
  });

  it('links tabcat to the built CLI entry point', () => {
    expect(manifest.bin?.['tabcat']).toBe('dist/cli.js');
    expect(readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8')).toMatch(/^#!\/usr\/bin\/env node/);
  });
});
