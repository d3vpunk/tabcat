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
const dirCache = new Map<string, { at: number; isDir: boolean }>();

function cacheSet<T>(store: Map<string, T>, key: string, value: T): void {
  store.delete(key); // re-insert -> fresh insertion order
  store.set(key, value);
  while (store.size > CACHE_MAX_DIRS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
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
    cacheSet(cache, absoluteDir, { at: Date.now(), entries });
    return entries;
  },

  // One stat, no listing: the existence question is asked per cd candidate
  // on every keystroke, and listing the parent would stat every symlink in it.
  isDirectory(absolutePath: string): boolean {
    const cached = dirCache.get(absolutePath);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.isDir;
    const isDir = isDirectory(absolutePath);
    cacheSet(dirCache, absolutePath, { at: Date.now(), isDir });
    return isDir;
  },
};

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
