import { readdirSync, statSync } from 'node:fs';
import { FsEntry, FsLike } from '../engine/fs-completer.js';

// Short-lived cache: predict() fires per keystroke — without a cache
// every character would re-read and re-stat the same directory.
const CACHE_TTL_MS = 2000;
// Hard upper bound against creeping growth in long sessions (one
// entry per visited directory). Map iterates in insertion order —
// the first key is the oldest.
const CACHE_MAX_DIRS = 256;
const cache = new Map<string, { at: number; entries: FsEntry[] | null }>();

function cacheSet(dir: string, value: { at: number; entries: FsEntry[] | null }): void {
  cache.delete(dir); // re-insert -> fresh insertion order
  cache.set(dir, value);
  while (cache.size > CACHE_MAX_DIRS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export const realFs: FsLike = {
  readdir(absoluteDir: string): FsEntry[] | null {
    const cached = cache.get(absoluteDir);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;

    let entries: FsEntry[] | null;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true }).map((dirent) => ({
        name: dirent.name,
        isDir: dirent.isDirectory() || (dirent.isSymbolicLink() && isDirectory(`${absoluteDir}/${dirent.name}`)),
      }));
    } catch {
      entries = null;
    }
    cacheSet(absoluteDir, { at: Date.now(), entries });
    return entries;
  },
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
