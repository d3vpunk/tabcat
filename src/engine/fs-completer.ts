export interface FsEntry {
  name: string;
  isDir: boolean;
}

/** Injectable filesystem — tests use a fake, the REPL uses the real FS. */
export interface FsLike {
  /** Entries of a directory, or null if not readable/existent. */
  readdir(absoluteDir: string): FsEntry[] | null;
}

export interface FsCandidate {
  /** Full entry name, with '/' appended for directories. */
  text: string;
  isDir: boolean;
}

/**
 * Completes a path-like token (e.g. "module/con") against the filesystem
 * relative to cwd. An empty token is deliberately not completed — otherwise
 * every directory listing would flood the dropdown.
 */
export function completePathToken(token: string, cwd: string, fs: FsLike, home?: string): FsCandidate[] {
  if (token.length === 0) return [];

  // "~/" -> home directory (otherwise a directory named "~" would be read
  // relative to cwd — it never exists, completion under $HOME would silently break).
  const expanded = home !== undefined && token.startsWith('~/') ? home + token.slice(1) : token;

  const lastSlash = expanded.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : '';
  const basePrefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;

  const absoluteDir = dirPart.startsWith('/')
    ? stripTrailingSlash(dirPart)
    : joinPath(cwd, stripTrailingSlash(dirPart));

  const entries = fs.readdir(absoluteDir === '' ? '/' : absoluteDir);
  if (!entries) return [];

  // Match case-insensitively (the macOS FS is too) — the inserted text is
  // always the entry's canonical spelling, not the typed prefix.
  const baseLower = basePrefix.toLowerCase();
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(baseLower))
    .sort((a, b) => compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.name, b.name))
    .map((e) => ({ text: e.isDir ? `${e.name}/` : e.name, isDir: e.isDir }));
}

/**
 * Does `target` name a directory when resolved from `cwd`? `..`, `-` and a
 * bare `~` always do; `~/x` resolves against `home`. Answers true when it
 * cannot tell (no home directory for `~/x`) — the caller demotes on false,
 * and demoting what might well exist is worse than not demoting.
 * Case-insensitive like completePathToken: the macOS filesystem is too.
 */
export function directoryExists(target: string, cwd: string, fs: FsLike, home?: string): boolean {
  if (target === '' || target === '.' || target === '..' || target === '-' || target === '~') return true;
  // Learned lines carry shell escapes (`My\ Dir`); the filesystem does not.
  let path = stripTrailingSlash(target.replace(/\\(.)/g, '$1'));
  if (path.startsWith('~/')) {
    if (home === undefined) return true;
    path = home + path.slice(1);
  }
  if (!path.startsWith('/')) path = joinPath(cwd, path);
  const slash = path.lastIndexOf('/');
  const dir = slash === 0 ? '/' : path.slice(0, slash);
  const base = path.slice(slash + 1);
  if (base === '' || base === '.' || base === '..') return true;
  const entries = fs.readdir(dir);
  if (!entries) return false;
  const baseLower = base.toLowerCase();
  return entries.some((e) => e.isDir && e.name.toLowerCase() === baseLower);
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function stripTrailingSlash(path: string): string {
  return path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
}

function joinPath(base: string, relative: string): string {
  if (relative === '' || relative === '.') return base;
  return `${stripTrailingSlash(base)}/${relative}`;
}
