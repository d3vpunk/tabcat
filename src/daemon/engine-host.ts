import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULT_SCORING, HistoryEntry, frecency } from '../engine/model.js';
import { MagicName, NameIndex, NameScope, activeIn, handleIssue, makeName, validateHandle } from '../engine/names.js';
import { appendName, appendTombstone, namesFileFor, readNames } from '../engine/names-store.js';
import { FsLike } from '../engine/fs-completer.js';
import { Prediction, Predictor } from '../engine/predictor.js';
import { fuzzySearch } from '../repl/history-search.js';
import { MAX_HISTORY_ENTRIES, appendHistory, compactHistory, forgetHistory, parseHistoryLine } from '../engine/store.js';

export type HostState = 'warming' | 'ready';

export interface EngineHostOptions {
  historyFile: string;
  now?: () => number;
  fs?: FsLike;
  homeDir?: string;
  /** TABCAT_MAGIC_NAMES=0 parity: dormant magic layer, empty index. */
  magicNames?: boolean;
  maxEntries?: number;
  onWarn?: (message: string) => void;
}

export interface LearnResult {
  learned: boolean;
  /** Set when the append failed — the daemon reports it once and keeps serving predictions. */
  error?: string;
}

export interface NamesCreateResult {
  created: boolean;
  /** Handle rejected (taken, collides with a real command, malformed). */
  reason?: string;
}

export interface CwdEntry {
  path: string;
  score: number;
  /** Epoch millis of the most recent command seen in this directory. */
  lastUsed: number;
}

export interface HostStats {
  state: HostState;
  entries: number;
  names: number;
  historyFile: string;
  historyWritable: boolean;
  /** Full model rebuilds so far. Observable on purpose: a rebuild costs O(all
   *  entries) and must stay rare — see the tail-follow contract. */
  rebuilds: number;
}

const READ_CHUNK = 64 * 1024;

/**
 * Timestamps kept per directory. Bounded for the same reason as
 * `maxOccurrencesPerEdge`: the youngest samples decide the ranking, and memory
 * must not scale with MAX_HISTORY_ENTRIES.
 */
const MAX_CWD_SAMPLES = 64;

/**
 * Only the trailing slash — a pure string rule. Resolving symlinks would mean
 * filesystem calls on the load path, so `/x/y` and a symlinked alias of it stay
 * two directories; `/x/y` and `/x/y/` do not.
 */
const normalizeCwd = (cwd: string): string => (cwd.length > 1 && cwd.endsWith('/') ? cwd.slice(0, -1) : cwd);

/**
 * Owns the engine state a daemon serves: predictor, magic-name index, and the
 * bookkeeping that keeps both in sync with files other processes also write
 * (a second shell, or the REPL).
 *
 * Freshness is a byte-offset tail follow, not an mtime-triggered reload:
 * rebuilding the model costs O(all entries) — ~130 ms at 2.4k entries — and
 * with several open terminals a foreign `learn` would trigger it constantly.
 * Reading only the appended bytes costs O(new lines). A full rebuild happens
 * only when the file shrank or its inode changed, i.e. someone compacted it.
 */
export class EngineHost {
  private predictor: Predictor | null = null;
  private readonly nameIndex = new NameIndex();
  private readonly namesFile: string;
  private readonly maxEntries: number;
  private readonly now: () => number;

  private offset = 0;
  private ino = -1;
  private decoder = new StringDecoder('utf8');
  private partial = '';
  private entryCount = 0;
  private historyWritable = true;
  private namesSignature = '';
  /**
   * Command lines newest-first and deduplicated — the contract `fuzzySearch`
   * expects. Maintained incrementally so the search key never re-scans the
   * whole history.
   */
  private recent: string[] = [];
  private recentSeen = new Set<string>();
  /**
   * Timestamps per working directory, oldest first — the input for `cwds`.
   * Maintained in the same two places as `recent`, for the same reason.
   */
  private cwdSamples = new Map<string, number[]>();
  private rebuilds = 0;

  constructor(private readonly options: EngineHostOptions) {
    this.namesFile = namesFileFor(options.historyFile);
    this.maxEntries = options.maxEntries ?? MAX_HISTORY_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  get state(): HostState {
    return this.predictor === null ? 'warming' : 'ready';
  }

  /**
   * Compacts once, then learns the whole history. Blocking and CPU-bound —
   * the caller listens on the socket BEFORE calling this, so early requests
   * get answered with `warming` instead of a connection refusal.
   */
  build(): void {
    try {
      compactHistory(this.options.historyFile, this.maxEntries, (count) =>
        this.options.onWarn?.(`skipped ${count} invalid history line(s) (${this.options.historyFile})`),
      );
    } catch (error) {
      // A busy lock or a read-only directory must not prevent serving.
      this.options.onWarn?.(`compaction skipped: ${messageOf(error)}`);
    }
    this.loadAll();
    this.refreshNames();
  }

  /** Cheap per-request freshness check: appended lines in, foreign compaction detected. */
  refresh(): void {
    if (this.predictor === null) return;
    this.refreshHistory();
    this.refreshNames();
  }

  predict(input: { line: string; cursor: number; cwd: string }): Prediction {
    if (this.predictor === null) throw new Error('predictor is still warming');
    this.refresh();
    return this.predictor.predict(input);
  }

  /**
   * Which handle to show as a badge for the line being typed, in the order the
   * REPL uses: the typed line itself, then the line the top candidate would
   * produce (`app.tsx` does the same via acceptedLine), then a prefix hint so
   * the indicator appears while typing rather than after the last chunk.
   */
  handleHint(line: string, cwd: string, acceptedLine?: string): string {
    const exact = this.nameIndex.handleFor(line.trim(), cwd);
    if (exact !== null) return exact;
    if (acceptedLine !== undefined) {
      const accepted = this.nameIndex.handleFor(acceptedLine.trim(), cwd);
      if (accepted !== null) return accepted;
    }
    return this.nameIndex.handleForPrefix(line, cwd) ?? '';
  }

  /** What a handle expands to in `cwd`, or '' — drives the Enter expansion. */
  resolveHandle(handle: string, cwd: string): string {
    this.refreshNames();
    return this.nameIndex.resolve(handle, cwd) ?? '';
  }

  /** Fuzzy history search, same ranking the REPL's own search uses. */
  search(query: string, limit: number): string[] {
    this.refresh();
    return fuzzySearch(query, this.recent, limit);
  }

  /**
   * Appends and learns. The entry is learned by re-reading it through the tail
   * follow rather than by calling `predictor.learn` directly: refresh-append-
   * refresh cannot double-learn our own line and cannot skip a foreign line
   * that landed in between, which any "advance the offset to EOF" shortcut can.
   *
   * Everything is appended, including exit 126/127 — `Predictor.learn` filters
   * those itself. That is exactly what the REPL does (`run.ts`), and diverging
   * here would give the two front ends different history files.
   */
  learn(entry: HistoryEntry): LearnResult {
    if (!this.historyWritable) return { learned: false, error: 'history is not writable' };
    this.refresh();
    try {
      appendHistory(this.options.historyFile, entry);
    } catch (error) {
      const message = messageOf(error);
      // A busy lock is transient: the REPL, an import or another daemon holds it
      // for a moment. Latching on that would silently drop a whole session.
      if (isPermanentWriteError(error)) this.historyWritable = false;
      this.options.onWarn?.(`history could not be saved (${this.options.historyFile}): ${message}`);
      return { learned: false, error: message };
    }
    this.refresh();
    return { learned: true };
  }

  namesList(cwd: string): MagicName[] {
    this.refreshNames();
    return this.nameIndex
      .all()
      .filter((name) => activeIn(name, cwd))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  namesCreate(name: string, line: string, cwd: string, scope: NameScope): NamesCreateResult {
    this.refreshNames();
    // Same guard as the REPL naming badge: the handle must be free on THIS
    // level and must not shadow the command's own program name.
    // `line` is exempt: re-labelling a command it already owns is no collision.
    const handles = this.nameIndex.blockingHandles(scope, cwd, line);
    const accepted = validateHandle(name, line, handles);
    if (accepted === null) {
      return { created: false, reason: handleIssue(name.toLowerCase(), line, handles) ?? 'malformed' };
    }
    const magicName: MagicName = makeName(accepted, line, scope, cwd, this.now());
    if (!appendName(this.namesFile, magicName)) {
      // Nothing on disk means no other shell and not the REPL would ever see
      // this handle — do not pretend it exists.
      return { created: false, reason: 'not-saved' };
    }
    this.nameIndex.add(magicName);
    // Forget the signature instead of adopting it: a foreign name appended
    // between our write and a stat would otherwise be skipped.
    this.namesSignature = '';
    return { created: true };
  }

  /** Tombstone, mirroring the REPL's forget path — append-only, never rewrites. */
  namesDelete(line: string): boolean {
    this.refreshNames();
    if (!this.nameIndex.has(line)) return false;
    if (!appendTombstone(this.namesFile, line, this.now())) return false;
    this.nameIndex.remove(line);
    this.namesSignature = '';
    return true;
  }

  /**
   * Removes every occurrence of `line` from the history and rebuilds.
   *
   * A rebuild rather than an unlearn, and rebuilding NOW rather than letting
   * the tail follow notice the changed inode: the client that asked is about
   * to request a fresh list, and serving the forgotten line back once more is
   * exactly the outcome the op exists to prevent. Deliberately O(all entries)
   * — forgetting is a deliberate act, never a keystroke.
   */
  forget(line: string): number {
    const removed = forgetHistory(this.options.historyFile, line);
    if (removed === 0) return 0;
    this.loadAll();
    return removed;
  }

  /** Periodic maintenance: without it a plugin-only user never compacts, since
   *  the REPL is the only other place that does (`run.ts` at startup). */
  compact(): void {
    try {
      compactHistory(this.options.historyFile, this.maxEntries);
    } catch (error) {
      this.options.onWarn?.(`compaction skipped: ${messageOf(error)}`);
      return;
    }
    // refresh(), not loadAll(): compactHistory only rewrites the file when the
    // cap is exceeded, which is rare. Its rename changes the inode, so a real
    // compaction still triggers the rebuild — a no-op stays a no-op instead of
    // freezing every shell's completion every six hours.
    this.refresh();
  }

  stats(): HostStats {
    return {
      state: this.state,
      entries: this.entryCount,
      names: this.nameIndex.all().length,
      historyFile: this.options.historyFile,
      historyWritable: this.historyWritable,
      rebuilds: this.rebuilds,
    };
  }

  /**
   * Full (re)build from the file. Reads exactly the bytes that existed at
   * `stat` time and sets the offset to that size: bytes appended during the
   * read stay unlearned and are picked up by the next refresh — learned once,
   * never twice.
   */
  private loadAll(): void {
    this.rebuilds++;
    const stats = statOrNull(this.options.historyFile);
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.entryCount = 0;
    this.offset = 0;
    this.ino = stats?.ino ?? -1;
    this.recent = [];
    this.recentSeen = new Set();
    this.cwdSamples = new Map();

    const entries: HistoryEntry[] = [];
    if (stats !== null && stats.size > 0) {
      let fd: number | null = null;
      try {
        fd = openSync(this.options.historyFile, 'r');
        const opened = fstatSync(fd);
        this.ino = opened.ino;
        if (this.readRange(fd, 0, opened.size, (line) => {
          const entry = parseHistoryLine(line);
          if (entry !== null) entries.push(entry);
        })) {
          this.offset = opened.size;
        } else {
          // A half-read history would silently skew every ranking. Drop what was
          // parsed, warn, and leave the inode unknown so the next request
          // retries instead of serving an incomplete model.
          this.options.onWarn?.(`history could only be read partially (${this.options.historyFile})`);
          entries.length = 0;
          this.ino = -1;
        }
      } catch {
        this.ino = -1;
      } finally {
        if (fd !== null) closeSync(fd);
      }
    }
    this.entryCount = entries.length;
    // Oldest first: rememberRecent unshifts, so the newest ends up in front.
    for (const entry of entries) {
      this.rememberRecent(entry.line);
      this.rememberCwd(entry);
    }
    this.predictor = new Predictor(entries.filter(isSingleLine), {
      now: this.now,
      ...(this.options.fs !== undefined ? { fs: this.options.fs } : {}),
      ...(this.options.homeDir !== undefined ? { homeDir: this.options.homeDir } : {}),
      ...(this.options.magicNames === false ? {} : { names: this.nameIndex }),
    });
  }

  private refreshHistory(): void {
    let fd: number;
    try {
      fd = openSync(this.options.historyFile, 'r');
    } catch {
      return; // Gone or unreadable: keep serving what we learned.
    }
    try {
      // fstat on the open fd, not stat on the path: a compaction landing between
      // a path stat and the open would have us read the NEW file from an offset
      // that belonged to the old one.
      const stats = fstatSync(fd);
      // The newline probe only applies when nothing is buffered: with a partial
      // trailing fragment the offset legitimately sits mid-line, and probing it
      // would force a full rebuild on every request until the writer is done.
      if (stats.ino !== this.ino || stats.size < this.offset || (this.partial === '' && !this.offsetLooksSane(fd))) {
        this.loadAll();
        return;
      }
      if (stats.size === this.offset) return;
      const read = this.readRange(fd, this.offset, stats.size, (line) => {
        const entry = parseHistoryLine(line);
        if (entry === null) return;
        this.entryCount++;
        this.rememberRecent(entry.line);
        this.rememberCwd(entry);
        if (isSingleLine(entry)) this.predictor?.learn(entry);
      });
      // A partial read must not advance past what was actually consumed.
      if (read) this.offset = stats.size;
      else this.ino = -1; // force a rebuild on the next request
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Our offset must sit right behind a newline. An in-place rewrite that keeps
   * the inode and grows the file (restoring a backup with `cat`) would otherwise
   * be parsed from a byte offset that means nothing in the new content.
   */
  private offsetLooksSane(fd: number): boolean {
    if (this.offset === 0) return true;
    try {
      const byte = Buffer.allocUnsafe(1);
      const read = readSync(fd, byte, 0, 1, this.offset - 1);
      return read === 1 && byte[0] === 0x0a;
    } catch {
      return false;
    }
  }

  /**
   * Reads [from, to) and hands over complete lines. A trailing fragment (a
   * writer mid-append) stays buffered in `partial`; multi-byte characters
   * split across a chunk boundary are held by the StringDecoder.
   */
  private readRange(fd: number, from: number, to: number, onLine: (line: string) => void): boolean {
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    let position = from;
    while (position < to) {
      let bytes: number;
      try {
        bytes = readSync(fd, buffer, 0, Math.min(buffer.length, to - position), position);
      } catch {
        return false;
      }
      if (bytes <= 0) return false;
      position += bytes;
      this.partial += this.decoder.write(buffer.subarray(0, bytes));
      let newline = this.partial.indexOf('\n');
      while (newline >= 0) {
        onLine(this.partial.slice(0, newline));
        this.partial = this.partial.slice(newline + 1);
        newline = this.partial.indexOf('\n');
      }
    }
    return true;
  }

  private refreshNames(): void {
    if (this.options.magicNames === false) return;
    const stats = statOrNull(this.namesFile);
    const signature = stats === null ? '' : `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    if (signature === this.namesSignature) return;
    try {
      // Read after the stat: a write landing in between only costs one extra
      // reload next time — reset() is idempotent.
      this.nameIndex.reset(readNames(this.namesFile));
    } catch (error) {
      // An unreadable names.jsonl must not kill the daemon for every shell.
      this.options.onWarn?.(`names could not be read (${this.namesFile}): ${messageOf(error)}`);
      return;
    }
    this.namesSignature = signature;
  }

  /**
   * Records that work happened in a directory. Called only from the two places
   * that parse a history line — never from `learn()`, so it inherits the tail
   * follow's "learned once, never twice" property and also sees the entries the
   * REPL and `import` write straight to the file without asking the daemon.
   *
   * Imported entries carry `cwd: null` and are skipped: zsh history has no
   * directory, and guessing one would be indistinguishable from having learned it.
   */
  private rememberCwd(entry: HistoryEntry): void {
    if (entry.cwd === null) return;
    const path = normalizeCwd(entry.cwd);
    if (path === '') return;
    const samples = this.cwdSamples.get(path);
    if (samples === undefined) {
      this.cwdSamples.set(path, [entry.ts]);
      return;
    }
    samples.push(entry.ts);
    // Both call sites feed lines in file order, so the oldest sits in front.
    if (samples.length > MAX_CWD_SAMPLES) samples.shift();
  }

  /**
   * Directories ranked by frecency — the chip row a GUI offers before anything
   * is typed, since a floating window has no working directory of its own.
   *
   * Deliberately no "does it still exist" flag: `handleLine` runs synchronously
   * in the daemon's single thread, so one stat on a hung network mount would
   * block the Tab key in every open shell. The caller stats.
   */
  cwds(limit: number): CwdEntry[] {
    this.refresh();
    const now = this.now();
    const ranked: CwdEntry[] = [];
    for (const [path, samples] of this.cwdSamples) {
      let score = 0;
      // The maximum, not the last element: history.jsonl is chronological in
      // practice, but a clock that jumped backwards would otherwise make
      // lastUsed report something that is not the most recent use.
      let lastUsed = 0;
      for (const ts of samples) {
        score += frecency(ts, now, DEFAULT_SCORING);
        if (ts > lastUsed) lastUsed = ts;
      }
      ranked.push({ path, score, lastUsed });
    }
    ranked.sort((a, b) => b.score - a.score || b.lastUsed - a.lastUsed);
    return ranked.slice(0, limit);
  }

  /** Newest-first, one entry per distinct line: a repeated command moves up
   *  instead of appearing twice. */
  private rememberRecent(line: string): void {
    // An empty command would serialise to an all-empty response row, and an
    // empty line is the wire's block terminator.
    if (line === '') return;
    if (this.recentSeen.has(line)) {
      const index = this.recent.indexOf(line);
      if (index >= 0) this.recent.splice(index, 1);
    } else {
      this.recentSeen.add(line);
    }
    this.recent.unshift(line);
  }

  /** After our own write: adopt the new file state so the next refresh is a no-op. */
  private snapshotNames(): void {
    const stats = statOrNull(this.namesFile);
    this.namesSignature = stats === null ? '' : `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  }
}

/**
 * Multiline entries never feed prediction — same rule as the REPL: the
 * single-line ghost and dropdown cannot render them, and a collapsed variant
 * would corrupt `\`-continued commands. They stay in the history file.
 */
const isSingleLine = (entry: HistoryEntry): boolean => !entry.line.includes('\n');

const statOrNull = (file: string): Stats | null => {
  try {
    return statSync(file);
  } catch {
    return null;
  }
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Permanent = no point retrying this session. A busy lock, a timeout or a
 * transient I/O hiccup is not permanent; a read-only filesystem is.
 */
function isPermanentWriteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  return ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EISDIR'].includes(code);
}
