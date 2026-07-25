import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Server, Socket, createServer } from 'node:net';
import { FsLike } from '../engine/fs-completer.js';
import { RankedCandidate } from '../engine/predictor.js';
import { VERSION } from '../version.js';
import { EngineHost } from './engine-host.js';
import { pingDaemon } from './client.js';
import { ensureSocketDir, pidfileFor } from './paths.js';
import { DaemonRequest, PROTOCOL_VERSION, encodeMessage, err, ok, parseRequest } from './protocol.js';

/** Long enough to survive a lunch break, short enough not to squat on ~170 MB RSS forever. */
export const DEFAULT_IDLE_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_COMPACT_INTERVAL_MS = 6 * 60 * 60_000;
/** One fd per interactive shell; 32 is generous and bounds a fork-bomb of terminals. */
export const DEFAULT_MAX_CONNECTIONS = 32;
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeIfPresent(socketPath);
    removeIfPresent(pidfile);
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
      socket.end(err('-', 'busy', `connection limit reached (${maxConnections})`));
      return;
    }
    connections.add(socket);
    socket.setNoDelay(true);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Compared in characters, not bytes: byte-exact counting would be O(n)
      // per chunk and the point here is only to bound a broken client.
      if (buffer.length > maxLineBytes && !buffer.includes('\n')) {
        socket.end(err('-', 'too_long', `request exceeds ${maxLineBytes} characters`));
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        // An empty line is the response terminator, harmless as input: ignore
        // it so a client echoing frames back does not get errors.
        if (line !== '') {
          lastActivity = Date.now();
          const result = handleLine(line, host, options);
          if (result.response !== null) socket.write(result.response);
          // Shut down only after the reply is queued — stop() destroys the
          // connection, so triggering it inline would swallow the `ok`.
          if (result.shutdown === true) setImmediate(() => void stop());
        }
        newline = buffer.indexOf('\n');
      }
    });
  });

  await listenOn(server, socketPath);
  // The socket inherits umask otherwise — 0600 is what keeps another user on
  // the machine from talking to this daemon (and reading the command lines).
  chmodSync(socketPath, 0o600);
  writePidfile(pidfile);

  // Both timers are unref'd: the listening server keeps the process alive, and
  // after close() nothing should linger and hold the event loop open.
  idleTimer = setInterval(
    () => {
      if (Date.now() - lastActivity >= idleTimeoutMs) void stop();
    },
    Math.max(1_000, Math.min(60_000, Math.floor(idleTimeoutMs / 4))),
  );
  idleTimer.unref();

  compactTimer = setInterval(() => host.compact(), options.compactIntervalMs ?? DEFAULT_COMPACT_INTERVAL_MS);
  compactTimer.unref();

  let ready: Promise<void>;
  if (options.build === 'sync') {
    host.build();
    ready = Promise.resolve();
  } else if (options.build === 'manual') {
    ready = Promise.resolve();
  } else {
    ready = buildSoon(host);
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
  const info = await pingDaemon(socketPath, 500);
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
          rows.push(candidateRow(candidate, prediction.prefix));
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
 */
function candidateRow(candidate: RankedCandidate, prefix: string): string[] {
  return [
    candidate.insert,
    candidate.display,
    candidate.source,
    candidate.magicName ?? '',
    String(candidate.replacePrefixLength ?? prefix.length),
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
const buildSoon = (host: EngineHost): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(() => {
      host.build();
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

const removeIfPresent = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing to do: another daemon may already own the path again.
  }
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
