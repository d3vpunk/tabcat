import { closeSync, openSync, readSync, statSync, type Stats } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { HistoryEntry } from '../engine/model.js';
import { MagicName, NameIndex, handleIssue, validateHandle } from '../engine/names.js';
import { appendName, namesFileFor, readNames } from '../engine/names-store.js';
import { FsLike } from '../engine/fs-completer.js';
import { Prediction, Predictor } from '../engine/predictor.js';
import { fuzzySearch } from '../repl/history-search.js';
import { MAX_HISTORY_ENTRIES, appendHistory, compactHistory, parseHistoryLine } from '../engine/store.js';

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

export interface HostStats {
  state: HostState;
  entries: number;
  names: number;
  historyFile: string;
  historyWritable: boolean;
}

const READ_CHUNK = 64 * 1024;

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

  /** Handle of an EXACT line, for the plugin's badge — no extra roundtrip. */
  handleFor(line: string, cwd: string): string {
    return this.nameIndex.handleFor(line, cwd) ?? '';
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
      this.historyWritable = false;
      const message = messageOf(error);
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
      .filter((name) => name.cwds.length === 0 || name.cwds.includes(cwd))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  namesCreate(name: string, line: string, cwd: string): NamesCreateResult {
    this.refreshNames();
    // Same guard as the REPL naming badge: handle must be free in this cwd and
    // must not shadow the command's own program name.
    const handles = this.nameIndex.handles(cwd);
    const accepted = validateHandle(name, line, handles);
    if (accepted === null) {
      return { created: false, reason: handleIssue(name.toLowerCase(), line, handles) ?? 'malformed' };
    }
    const magicName: MagicName = { name: accepted, line, cwds: [cwd], ts: this.now() };
    this.nameIndex.add(magicName);
    appendName(this.namesFile, magicName);
    this.snapshotNames();
    return { created: true };
  }

  /** Tombstone, mirroring the REPL's forget path — append-only, never rewrites. */
  namesDelete(line: string): boolean {
    this.refreshNames();
    if (!this.nameIndex.has(line)) return false;
    this.nameIndex.remove(line);
    appendName(this.namesFile, { name: '', line, cwds: [], ts: this.now() });
    this.snapshotNames();
    return true;
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
    // Our own compaction replaced the file — the offset and inode are stale.
    this.loadAll();
  }

  stats(): HostStats {
    return {
      state: this.state,
      entries: this.entryCount,
      names: this.nameIndex.all().length,
      historyFile: this.options.historyFile,
      historyWritable: this.historyWritable,
    };
  }

  /**
   * Full (re)build from the file. Reads exactly the bytes that existed at
   * `stat` time and sets the offset to that size: bytes appended during the
   * read stay unlearned and are picked up by the next refresh — learned once,
   * never twice.
   */
  private loadAll(): void {
    const stats = statOrNull(this.options.historyFile);
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.entryCount = 0;
    this.offset = 0;
    this.ino = stats?.ino ?? -1;
    this.recent = [];
    this.recentSeen = new Set();

    const entries: HistoryEntry[] = [];
    if (stats !== null && stats.size > 0) {
      this.readRange(0, stats.size, (line) => {
        const entry = parseHistoryLine(line);
        if (entry !== null) entries.push(entry);
      });
      this.offset = stats.size;
    }
    this.entryCount = entries.length;
    // Oldest first: rememberRecent unshifts, so the newest ends up in front.
    for (const entry of entries) this.rememberRecent(entry.line);
    this.predictor = new Predictor(entries.filter(isSingleLine), {
      now: this.now,
      ...(this.options.fs !== undefined ? { fs: this.options.fs } : {}),
      ...(this.options.homeDir !== undefined ? { homeDir: this.options.homeDir } : {}),
      ...(this.options.magicNames === false ? {} : { names: this.nameIndex }),
    });
  }

  private refreshHistory(): void {
    const stats = statOrNull(this.options.historyFile);
    if (stats === null) return; // File vanished: keep serving what we learned.
    if (stats.ino !== this.ino || stats.size < this.offset) {
      // Someone compacted (rewrite via rename) or truncated the file.
      this.loadAll();
      return;
    }
    if (stats.size === this.offset) return;
    this.readRange(this.offset, stats.size, (line) => {
      const entry = parseHistoryLine(line);
      if (entry === null) return;
      this.entryCount++;
      this.rememberRecent(entry.line);
      if (isSingleLine(entry)) this.predictor?.learn(entry);
    });
    this.offset = stats.size;
  }

  /**
   * Reads [from, to) and hands over complete lines. A trailing fragment (a
   * writer mid-append) stays buffered in `partial`; multi-byte characters
   * split across a chunk boundary are held by the StringDecoder.
   */
  private readRange(from: number, to: number, onLine: (line: string) => void): void {
    let fd: number;
    try {
      fd = openSync(this.options.historyFile, 'r');
    } catch {
      return;
    }
    try {
      const buffer = Buffer.allocUnsafe(READ_CHUNK);
      let position = from;
      while (position < to) {
        const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, to - position), position);
        if (bytes <= 0) break;
        position += bytes;
        this.partial += this.decoder.write(buffer.subarray(0, bytes));
        let newline = this.partial.indexOf('\n');
        while (newline >= 0) {
          onLine(this.partial.slice(0, newline));
          this.partial = this.partial.slice(newline + 1);
          newline = this.partial.indexOf('\n');
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  private refreshNames(): void {
    if (this.options.magicNames === false) return;
    const stats = statOrNull(this.namesFile);
    const signature = stats === null ? '' : `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
    if (signature === this.namesSignature) return;
    // Read after the stat: a write landing in between only costs one extra
    // reload next time — reset() is idempotent.
    this.nameIndex.reset(readNames(this.namesFile));
    this.namesSignature = signature;
  }

  /** Newest-first, one entry per distinct line: a repeated command moves up
   *  instead of appearing twice. */
  private rememberRecent(line: string): void {
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
