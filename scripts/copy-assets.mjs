#!/usr/bin/env node
// tsc only emits JavaScript — the zsh plugin has to be copied into dist/ by
// hand. `tabcat plugin init zsh` resolves it relative to its own module, so the
// file must sit one level above dist/plugin/.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = [['src/plugin/tabcat.plugin.zsh', 'dist/tabcat.plugin.zsh']];

for (const [from, to] of assets) {
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
  console.log(`copied ${from} -> ${to}`);
}
