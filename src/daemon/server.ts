import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Server, Socket, createServer } from 'node:net';
import { FsLike } from '../engine/fs-completer.js';
import { RankedCandidate } from '../engine/predictor.js';
import { VERSION } from '../version.js';
import { EngineHost } from './engine-host.js';
import { pingDaemon } from './client.js';
import { SocketPathError, ensureSocketDir, pidfileFor } from './paths.js';
import { DaemonRequest, PROTOCOL_VERSION, codePointLength, encodeMessage, err, ok, parseRequest } from './protocol.js';

/** Long enough to survive a lunch break, short enough not to squat on ~170 MB RSS forever. */
export const DEFAULT_IDLE_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_COMPACT_INTERVAL_MS = 6 * 60 * 60_000;
/** One fd per interactive shell; 32 is generous and bounds a fork-bomb of terminals. */
export const DEFAULT_MAX_CONNECTIONS = 32;
/** Must exceed the worst-case model build, or a warming daemon looks dead. */
export const CLAIM_PROBE_TIMEOUT_MS = 5_000;
/** A single request line above this means the client is broken or hostile. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

export interface DaemonOptions {
  socketPath: string;
  historyFile: string;
  idleTimeoutMs?: number;
  compactIntervalMs?: number;
  maxConnections?: number;
  maxLineBytes?: number;
  magicNames?: boolean;
  fs?: FsLike;
  homeDir?: string;
  now?: () => number;
  /**
   * When the model gets built. 'deferred' (default) builds right after the
   * socket is listening, so an early request answers `warming` instead of
   * hitting a refused connection. 'sync' blocks until ready, 'manual' leaves
   * it to the caller — both exist for tests.
   */
  build?: 'sync' | 'deferred' | 'manual';
  onWarn?: (message: string) => void;
}

export class AlreadyRunningError extends Error {}

export interface DaemonHandle {
  socketPath: string;
  host: EngineHost;
  /** Resolves once the predictor finished building — until then requests answer `warming`. */
  ready: Promise<void>;
  /** Resolves when the daemon stopped, whoever triggered it (shutdown op, idle, close()). */
  closed: Promise<void>;
  close(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const socketPath = ensureSocketDir(options.socketPath);
  await claimSocket(socketPath);

  const host = new EngineHost({
    historyFile: options.historyFile,
    ...(options.fs !== undefined ? { fs: options.fs } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.magicNames !== undefined ? { magicNames: options.magicNames } : {}),
    ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
  });

  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  /** Accepted connections — the cap counts these. */
  const connections = new Set<Socket>();
  /** Every socket, including ones turned away: close() must be able to destroy
   *  them, otherwise server.close() waits forever for a client that got a
   *  `busy` reply but never hung up. */
  const sockets = new Set<Socket>();
  const pidfile = pidfileFor(options.historyFile);

  let lastActivity = Date.now();
  let closing = false;
  let socketIno = -1;
  let idleTimer: NodeJS.Timeout | undefined;
  let compactTimer: NodeJS.Timeout | undefined;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const stop = async (): Promise<void> => {
    if (closing) return closed;
    closing = true;
    if (idleTimer !== undefined) clearInterval(idleTimer);
    if (compactTimer !== undefined) clearInterval(compactTimer);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    connections.clear();
    // server.close() unlinks the bound path itself — there is no way to keep it
    // from removing a socket another daemon may have put there meanwhile. What
    // prevents that situation is the claim probe above plus the self-check
    // below; this call only cleans up the normal case.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeIfPresent(socketPath);
    if (readPid(pidfile) === process.pid) removeIfPresent(pidfile);
    resolveClosed();
    return closed;
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      connections.delete(socket);
    });
    if (connections.size >= maxConnections) {
      // Answer before hanging up: a silent RST looks like a dead daemon and
      // would make the plugin spawn a second one.
      // end() only half-closes: a client that never hangs up would keep the fd
      // (and the entry in `sockets`) forever.
      socket.end(err('-', 'busy', `connection limit reached (${maxConnections})`), () => socket.destroy());
      return;
    }
    connections.add(socket);
    socket.setNoDelay(true);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        // An empty line is the response terminator, harmless as input: ignore
        // it so a client echoing frames back does not get errors.
        if (line !== '') {
          lastActivity = Date.now();
          // One bad file read must not take the daemon — and with it every
          // other shell's connection — down. handleLine runs inside a socket
          // 'data' callback, where a throw is an uncaught exception.
          let result: LineResult;
          try {
            result = handleLine(line, host, options);
          } catch (error) {
            options.onWarn?.(`request failed: ${messageOf(error)}`);
            result = { response: err(idOf(line), 'internal', messageOf(error)) };
          }
          if (result.response !== null) socket.write(result.response);
          // Shut down only after the reply is queued — stop() destroys the
          // connection, so triggering it inline would swallow the `ok`.
          if (result.shutdown === true) setImmediate(() => void stop());
        }
        newline = buffer.indexOf('\n');
      }
      // Complete requests are answered first, then what is left over is judged:
      // the guard has to measure the UNTERMINATED tail, and an earlier newline
      // in the same chunk must not let an unbounded fragment through.
      // Characters, not bytes — byte-exact counting would be O(n) per chunk and
      // the point is only to bound a broken client.
      if (buffer.length > maxLineBytes) {
        socket.end(err('-', 'too_long', `request exceeds ${maxLineBytes} characters`));
      }
    });
  });

  await listenOn(server, socketPath);
  try {
    // The socket inherits umask otherwise — 0600 is what keeps another user on
    // the machine from talking to this daemon (and reading the command lines).
    chmodSync(socketPath, 0o600);
    socketIno = inoOf(socketPath);
    // The directory was validated BEFORE the bind; re-check afterwards so a
    // directory swapped in between cannot leave us serving from a path someone
    // else controls.
    verifySocket(socketPath);
    writePidfile(pidfile);
  } catch (error) {
    // Never leave a listening server behind on a half-finished start.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  // Accept errors (EMFILE and friends) arrive as 'error' on the server; without
  // a listener Node turns them into an uncaught exception.
  server.on('error', (error) => options.onWarn?.(`server error: ${messageOf(error)}`));

  // Both timers are unref'd: the listening server keeps the process alive, and
  // after close() nothing should linger and hold the event loop open.
  idleTimer = setInterval(
    () => {
      // Our socket file is gone or belongs to someone else: nothing can reach us
      // any more. Exiting frees the model's memory and lets the next shell start
      // a daemon that is actually reachable, instead of squatting until the idle
      // timeout.
      if (socketIno !== -1 && inoOf(socketPath) !== socketIno) {
        options.onWarn?.(`socket ${socketPath} is no longer ours — shutting down`);
        void stop();
        return;
      }
      if (Date.now() - lastActivity >= idleTimeoutMs) void stop();
    },
    Math.max(1_000, Math.min(60_000, Math.floor(idleTimeoutMs / 4))),
  );
  idleTimer.unref();

  compactTimer = setInterval(() => {
    try {
      host.compact();
    } catch (error) {
      options.onWarn?.(`compaction failed: ${messageOf(error)}`);
    }
  }, options.compactIntervalMs ?? DEFAULT_COMPACT_INTERVAL_MS);
  compactTimer.unref();

  let ready: Promise<void>;
  if (options.build === 'sync') {
    host.build();
    ready = Promise.resolve();
  } else if (options.build === 'manual') {
    ready = Promise.resolve();
  } else {
    ready = buildSoon(host, () => closing);
  }

  return { socketPath, host, ready, closed, close: stop };
}

/**
 * Refuses to start when a live daemon already owns the socket, and clears the
 * file when nothing answers. A leftover socket after a crash or reboot would
 * otherwise make bind() fail with EADDRINUSE forever.
 */
async function claimSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  // Generous on purpose: a daemon that is still building its model cannot
  // answer (build() blocks the loop, and 20k entries take >500 ms). Declaring
  // it dead would start a second daemon on the same history.
  const info = await pingDaemon(socketPath, CLAIM_PROBE_TIMEOUT_MS);
  if (info !== null) {
    throw new AlreadyRunningError(`daemon already running on ${socketPath} (version ${info.version}, pid ${info.pid})`);
  }
  rmSync(socketPath, { force: true });
}

interface LineResult {
  response: string | null;
  shutdown?: true;
}

function handleLine(line: string, host: EngineHost, options: DaemonOptions): LineResult {
  const parsed = parseRequest(line);
  if (!parsed.ok) return { response: err(parsed.id, parsed.code, parsed.message) };
  const request = parsed.request;

  switch (request.op) {
    case 'ping':
      return { response: ok(request.id, VERSION, String(PROTOCOL_VERSION), host.state, String(process.pid)) };

    case 'shutdown':
      return { response: ok(request.id), shutdown: true };

    case 'predict': {
      if (host.state === 'warming') return { response: err(request.id, 'warming', 'predictor is still building') };
      try {
        const prediction = host.predict({ line: request.line, cursor: request.cursor, cwd: request.cwd });
        const limit = request.limit === 0 ? prediction.candidates.length : request.limit;
        // Header carries the badge handle so it costs no extra roundtrip.
        const top = prediction.candidates[0];
        const accepted =
          top === undefined ? undefined : acceptedLine(request.line, request.cursor, top, prediction.prefix.length);
        const rows: string[][] = [
          ['ok', request.id, prediction.prefix, host.handleHint(request.line, request.cwd, accepted)],
        ];
        for (const candidate of prediction.candidates.slice(0, limit)) {
          rows.push(candidateRow(candidate, prediction.prefix, request.line, request.cursor));
        }
        return { response: encodeMessage(rows) };
      } catch (error) {
        options.onWarn?.(`predict failed: ${messageOf(error)}`);
        return { response: err(request.id, 'internal', messageOf(error)) };
      }
    }

    case 'learn': {
      const result = host.learn({
        ts: request.ts,
        cwd: request.cwd,
        line: request.line,
        exitCode: request.exitCode,
        // No `completion` field: that telemetry only exists for input typed in
        // the REPL's own prompt. Omitted, exactly like an imported entry.
      });
      return {
        response: result.learned ? ok(request.id) : err(request.id, 'internal', result.error ?? 'learn failed'),
      };
    }

    case 'search': {
      if (host.state === 'warming') return { response: err(request.id, 'warming', 'predictor is still building') };
      const limit = request.limit === 0 ? 10 : request.limit;
      const rows: string[][] = [['ok', request.id]];
      for (const line of host.search(request.query, limit)) rows.push([line]);
      return { response: encodeMessage(rows) };
    }

    case 'cwds': {
      if (host.state === 'warming') return { response: err(request.id, 'warming', 'predictor is still building') };
      const limit = request.limit === 0 ? 10 : request.limit;
      const rows: string[][] = [['ok', request.id]];
      for (const entry of host.cwds(limit)) {
        // toFixed, not String(): a tiny score would serialise as 1e-7, which a
        // client parsing floats by hand reads as 1.
        rows.push([entry.path, entry.score.toFixed(4), String(entry.lastUsed)]);
      }
      // An empty result is the honest answer for a fresh install — every imported
      // entry has cwd null. The client falls back to its own seed instead of the
      // daemon inventing directories.
      return { response: encodeMessage(rows) };
    }

    case 'names': {
      if (request.sub === 'list') {
        const rows: string[][] = [['ok', request.id]];
        for (const name of host.namesList(request.cwd)) rows.push([name.name, name.line]);
        return { response: encodeMessage(rows) };
      }
      if (request.sub === 'resolve') {
        return { response: ok(request.id, host.resolveHandle(request.name, request.cwd)) };
      }
      if (request.sub === 'create') {
        const result = host.namesCreate(request.name, request.line, request.cwd);
        return {
          response: result.created
            ? ok(request.id, 'created')
            : err(request.id, 'bad_value', result.reason ?? 'rejected'),
        };
      }
      return { response: ok(request.id, host.namesDelete(request.line) ? 'deleted' : 'absent') };
    }
  }
}

/** How the line would read after accepting `candidate` — same rule the REPL
 *  applies in `acceptedLineFor`, so both front ends badge the same commands. */
function acceptedLine(line: string, cursor: number, candidate: RankedCandidate, prefixLength: number): string {
  const replaceFrom = cursor - (candidate.replacePrefixLength ?? prefixLength);
  return line.slice(0, Math.max(0, replaceFrom)) + candidate.display + line.slice(cursor);
}

/**
 * Wire shape of one candidate. `replacePrefixLength` is resolved here so the
 * shell never has to reason about defaults: accepting means replacing that many
 * characters left of the cursor with `display`. `insert` is what the ghost shows.
 *
 * The length goes out in CODE POINTS, not UTF-16 units — the shell cuts
 * characters, so an emoji inside the replaced prefix would otherwise make it cut
 * one too many.
 */
function candidateRow(candidate: RankedCandidate, prefix: string, line: string, cursor: number): string[] {
  const replaceUtf16 = candidate.replacePrefixLength ?? prefix.length;
  const replaced = line.slice(Math.max(0, cursor - replaceUtf16), cursor);
  return [
    candidate.insert,
    candidate.display,
    candidate.source,
    candidate.magicName ?? '',
    String(codePointLength(replaced)),
  ];
}

const listenOn = (server: Server, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

/**
 * Builds after the current tick so the socket is already accepting: an early
 * Tab gets a `warming` answer (and falls back to zsh completion) instead of a
 * connection refusal that would look like a crashed daemon.
 */
const buildSoon = (host: EngineHost, isClosing: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(() => {
      // A close() between listen and this tick means nobody is waiting for the
      // model — and build() would compact the history of a daemon that is gone.
      if (!isClosing()) host.build();
      resolve();
    });
  });

function writePidfile(pidfile: string): void {
  try {
    mkdirSync(dirname(pidfile), { recursive: true, mode: 0o700 });
    writeFileSync(pidfile, `${process.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Informational only — the socket, not the pidfile, is the source of truth.
  }
}

/**
 * The socket we just bound must be a socket, ours, and in a directory that is
 * still ours and still private. Checking only before bind leaves a window.
 */
function verifySocket(socketPath: string): void {
  const stats = lstatSync(socketPath);
  if (!stats.isSocket()) throw new SocketPathError(`not a socket after bind: ${socketPath}`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (uid >= 0 && stats.uid !== uid) throw new SocketPathError(`socket belongs to uid ${stats.uid}: ${socketPath}`);
  const dir = lstatSync(dirname(socketPath));
  if (uid >= 0 && dir.uid !== uid) throw new SocketPathError(`socket directory belongs to uid ${dir.uid}`);
  if ((dir.mode & 0o077) !== 0) throw new SocketPathError(`socket directory is not private: ${dirname(socketPath)}`);
}

const idOf = (line: string): string => {
  const id = line.split('\t')[1] ?? '-';
  return /^[A-Za-z0-9_-]{1,32}$/.test(id) ? id : '-';
};

const inoOf = (path: string): number => {
  try {
    return statSync(path).ino;
  } catch {
    return -1;
  }
};

const readPid = (pidfile: string): number => {
  try {
    return Number(readFileSync(pidfile, 'utf8').trim());
  } catch {
    return -1;
  }
};

const removeIfPresent = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing to do: another daemon may already own the path again.
  }
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
