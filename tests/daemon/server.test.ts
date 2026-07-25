import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlreadyRunningError, DaemonHandle, DaemonOptions, startDaemon } from '../../src/daemon/server.js';
import { pingDaemon, shutdownDaemon } from '../../src/daemon/client.js';
import { PROTOCOL_VERSION } from '../../src/daemon/protocol.js';
import { pidfileFor } from '../../src/daemon/paths.js';
import { HistoryEntry } from '../../src/engine/model.js';
import { VERSION } from '../../src/version.js';
import { TestClient, withTimeout } from './helpers.js';

const NO_FS = { readdir: () => null };
const CWD = '/work';

let dir: string;
/** Socket dir under /tmp on purpose: the sun_path limit is 104 bytes and the
 *  macOS tmpdir is already ~50 characters deep. */
let socketDir: string;
let historyFile: string;
let socketPath: string;
let running: DaemonHandle[] = [];

const entry = (line: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  ts: 1_700_000_000_000,
  cwd: CWD,
  line,
  ...over,
});

const writeHistory = (...entries: readonly HistoryEntry[]): void =>
  writeFileSync(historyFile, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

async function daemon(options: Partial<DaemonOptions> = {}): Promise<DaemonHandle> {
  const handle = await startDaemon({
    socketPath,
    historyFile,
    fs: NO_FS,
    homeDir: '/home/test',
    build: 'sync',
    ...options,
  });
  running.push(handle);
  return handle;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabcat-daemon-'));
  socketDir = mkdtempSync('/tmp/tc-');
  historyFile = join(dir, 'history.jsonl');
  socketPath = join(socketDir, 'daemon.sock');
});

afterEach(async () => {
  for (const handle of running) await handle.close();
  running = [];
  rmSync(dir, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
});

describe('daemon: ping and lifecycle', () => {
  it('answers ping with version, protocol, state and pid', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    const rows = await client.request('ping');
    expect(rows).toEqual([['ok', 't1', VERSION, String(PROTOCOL_VERSION), 'ready', String(process.pid)]]);
    client.close();
  });

  it('creates the socket with 0600 and a pidfile next to the history', async () => {
    await daemon();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(pidfileFor(historyFile), 'utf8').trim()).toBe(String(process.pid));
  });

  it('removes socket and pidfile on close', async () => {
    const handle = await daemon();
    await handle.close();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidfileFor(historyFile))).toBe(false);
  });

  it('refuses to start when a live daemon owns the socket', async () => {
    await daemon();
    await expect(daemon()).rejects.toBeInstanceOf(AlreadyRunningError);
  });

  it('clears a stale socket file left behind by a crash', async () => {
    // Not a socket at all — connect() fails, so nothing is listening.
    writeFileSync(socketPath, 'leftover');
    const handle = await daemon();
    expect(await pingDaemon(socketPath)).toMatchObject({ state: 'ready' });
    await handle.close();
  });

  it('shuts down on request and answers before closing', async () => {
    const handle = await daemon();
    expect(await shutdownDaemon(socketPath)).toBe(true);
    await withTimeout(handle.closed, 2_000, 'daemon did not close after shutdown');
    expect(existsSync(socketPath)).toBe(false);
  });

  it('exits after the idle timeout', async () => {
    const handle = await daemon({ idleTimeoutMs: 1_000 });
    await withTimeout(handle.closed, 5_000, 'daemon did not exit when idle');
    expect(existsSync(socketPath)).toBe(false);
  });

  it('stays alive while requests keep arriving', async () => {
    const handle = await daemon({ idleTimeoutMs: 1_500 });
    const client = await TestClient.connect(socketPath);
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect((await client.request('ping'))[0]?.[0]).toBe('ok');
    }
    client.close();
  });
});

describe('daemon: predict', () => {
  it('returns the prefix and one candidate row per candidate', async () => {
    writeHistory(entry('git status'), entry('git status'), entry('git commit -m fix'));
    await daemon();
    const client = await TestClient.connect(socketPath);
    const rows = await client.request('predict', '5', '4', CWD, 'git ');
    // Header: ok, id, typed prefix, handle of the exact line (empty here).
    expect(rows[0]).toEqual(['ok', 't1', '', '']);
    // `display` is token-scoped, not the whole line: with an empty prefix it
    // equals `insert`, and accepting appends it after 'git '.
    expect(rows.slice(1).map((row) => row[1])).toContain('status');
    // insert, display, source, magicName, replacePrefixLength
    expect(rows[1]).toHaveLength(5);
    client.close();
  });

  it('honours the limit so the ghost can ask for a single candidate', async () => {
    writeHistory(entry('git status'), entry('git commit'), entry('git push'), entry('git pull'));
    await daemon();
    const client = await TestClient.connect(socketPath);
    expect(await client.request('predict', '1', '4', CWD, 'git ')).toHaveLength(2);
    const all = await client.request('predict', '0', '4', CWD, 'git ');
    expect(all.length).toBeGreaterThan(2);
    client.close();
  });

  it('reports the typed prefix separately from the insert', async () => {
    writeHistory(entry('git status'), entry('git status'));
    await daemon();
    const client = await TestClient.connect(socketPath);
    const rows = await client.request('predict', '3', '5', CWD, 'git s');
    expect(rows[0]).toEqual(['ok', 't1', 's', '']);
    expect(rows[1]?.[0]).toBe('tatus');
    expect(rows[1]?.[1]).toBe('status');
    client.close();
  });

  it('round-trips a command containing a literal backslash-t', async () => {
    // The single-pass trap on the wire: escaping '\' to '\\' and decoding it
    // again must not produce a real tab. Real awk lines look exactly like this.
    writeHistory(entry("awk -F'\\t' '{print}' data"), entry("awk -F'\\t' '{print}' data"));
    await daemon();
    const client = await TestClient.connect(socketPath);
    const rows = await client.request('predict', '5', '4', CWD, 'awk ');
    expect(rows.slice(1).map((row) => row[1])).toContain("-F'\\t' '{print}' data");
    client.close();
  });

  it('round-trips a command containing a real tab', async () => {
    writeHistory(entry('echo a\tb'), entry('echo a\tb'));
    await daemon();
    const client = await TestClient.connect(socketPath);
    const rows = await client.request('predict', '5', '5', CWD, 'echo ');
    expect(rows.slice(1).map((row) => row[1])).toContain('a\tb');
    client.close();
  });

  it('answers `warming` until the model is built, then serves', async () => {
    writeHistory(entry('git status'), entry('git status'));
    const handle = await daemon({ build: 'manual' });
    const client = await TestClient.connect(socketPath);
    const early = await client.request('predict', '1', '4', CWD, 'git ');
    expect(early[0]?.slice(0, 3)).toEqual(['err', 't1', 'warming']);

    handle.host.build();
    const later = await client.request('predict', '1', '4', CWD, 'git ');
    expect(later[0]?.[0]).toBe('ok');
    client.close();
  });
});

describe('daemon: learn', () => {
  it('appends over the wire and predicts the entry afterwards', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    expect((await client.request('learn', '0', '1700000000000', CWD, 'npm run build'))[0]?.[0]).toBe('ok');
    expect((await client.request('learn', '0', '1700000000001', CWD, 'npm run build'))[0]?.[0]).toBe('ok');
    expect(readFileSync(historyFile, 'utf8').trim().split('\n')).toHaveLength(2);

    const rows = await client.request('predict', '5', '4', CWD, 'npm ');
    expect(rows.slice(1).map((row) => row[1])).toContain('run build');
    client.close();
  });

  it('writes no completion telemetry (shell input has none)', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    await client.request('learn', '0', '1700000000000', CWD, 'ls -la');
    const stored: unknown = JSON.parse(readFileSync(historyFile, 'utf8').trim());
    expect(stored).toEqual({ ts: 1700000000000, cwd: CWD, line: 'ls -la', exitCode: 0 });
    client.close();
  });

  it('preserves tabs and newlines through the wire', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    await client.request('learn', '0', '1700000000000', CWD, 'for f in *; do\n\techo $f\ndone');
    const stored = JSON.parse(readFileSync(historyFile, 'utf8').trim()) as HistoryEntry;
    expect(stored.line).toBe('for f in *; do\n\techo $f\ndone');
    client.close();
  });
});

describe('daemon: cwds', () => {
  it('answers with ranked directories over the wire', async () => {
    writeHistory(
      entry('a', { cwd: '/work/old', ts: 1_600_000_000_000 }),
      entry('b', { cwd: '/work/new', ts: Date.now() }),
    );
    await daemon();
    const client = await TestClient.connect(socketPath);
    const rows = await client.request('cwds', '10');
    expect(rows[0]?.[0]).toBe('ok');
    const listed = rows.slice(1);
    expect(listed.map((row) => row[0])).toEqual(['/work/new', '/work/old']);
    // path, score, lastUsed — score fixed-point so no client sees 1e-7.
    expect(listed[0]).toHaveLength(3);
    expect(listed[0]?.[1]).toMatch(/^\d+\.\d{4}$/);
    expect(Number(listed[0]?.[2])).toBeGreaterThan(Number(listed[1]?.[2]));
    client.close();
  });

  it('returns only the header when nothing was learned with a directory', async () => {
    writeHistory(entry('a', { cwd: null }));
    await daemon();
    const client = await TestClient.connect(socketPath);
    expect(await client.request('cwds', '10')).toEqual([['ok', 't1']]);
    client.close();
  });

  it('reports warming while the model is still building', async () => {
    writeHistory(entry('a'));
    await daemon({ build: 'manual' });
    const client = await TestClient.connect(socketPath);
    const rows = await client.request('cwds', '10');
    expect(rows[0]?.[0]).toBe('err');
    expect(rows[0]?.[2]).toBe('warming');
    client.close();
  });

  it('learns a directory it was told about in the same session', async () => {
    writeHistory(entry('a', { cwd: '/work' }));
    await daemon();
    const client = await TestClient.connect(socketPath);
    await client.request('learn', '0', String(Date.now()), '/fresh', 'npm test');
    expect((await client.request('cwds', '10')).slice(1).map((row) => row[0])).toContain('/fresh');
    client.close();
  });
});

describe('daemon: names', () => {
  it('creates, lists and deletes a handle', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    expect((await client.request('names', 'create', CWD, 'dep', 'docker compose up -d'))[0]).toEqual([
      'ok',
      't1',
      'created',
    ]);
    expect(await client.request('names', 'list', CWD, '', '')).toEqual([
      ['ok', 't2'],
      ['dep', 'docker compose up -d'],
    ]);
    expect((await client.request('names', 'delete', CWD, '', 'docker compose up -d'))[0]).toEqual([
      'ok',
      't3',
      'deleted',
    ]);
    expect((await client.request('names', 'delete', CWD, '', 'docker compose up -d'))[0]).toEqual(['ok', 't4', 'absent']);
    client.close();
  });

  it('rejects a taken handle with a reason', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    await client.request('names', 'create', CWD, 'dep', 'docker compose up -d');
    const rows = await client.request('names', 'create', CWD, 'dep', 'git push');
    expect(rows[0]).toEqual(['err', 't2', 'bad_value', 'taken']);
    client.close();
  });

  it('badges a handle while the command is still being typed', async () => {
    // Point of the header handle: the indicator has to arrive early, not after
    // the last chunk was completed.
    writeHistory(entry('docker compose up -d'), entry('docker compose up -d'));
    await daemon();
    const client = await TestClient.connect(socketPath);
    await client.request('names', 'create', CWD, 'dep', 'docker compose up -d');
    const early = await client.request('predict', '3', '10', CWD, 'docker com');
    expect(early[0]?.[3]).toBe('dep');
    const exact = await client.request('predict', '3', '20', CWD, 'docker compose up -d');
    expect(exact[0]?.[3]).toBe('dep');
    const unrelated = await client.request('predict', '3', '4', CWD, 'git ');
    expect(unrelated[0]?.[3]).toBe('');
    client.close();
  });

  it('badges the line the top candidate would produce', async () => {
    // Parity with the REPL, which badges via acceptedLineFor: the suggestion
    // completes to a named command even though the typed text does not prefix it.
    writeHistory(entry('deploy staging now'), entry('deploy staging now'));
    await daemon();
    const client = await TestClient.connect(socketPath);
    await client.request('names', 'create', CWD, 'dsn', 'deploy staging now');
    const rows = await client.request('predict', '3', '7', CWD, 'deploy ');
    expect(rows[0]?.[3]).toBe('dsn');
    client.close();
  });

  it('surfaces a created handle as a magic candidate', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    await client.request('names', 'create', CWD, 'dep', 'docker compose up -d');
    const rows = await client.request('predict', '5', '2', CWD, 'de');
    expect(rows.slice(1).map((row) => [row[1], row[2], row[3]])).toContainEqual([
      'docker compose up -d',
      'magic',
      'dep',
    ]);
    client.close();
  });
});

describe('daemon: resilience', () => {
  it('answers with an error instead of dying when a file cannot be read', async () => {
    // handleLine runs inside a socket data callback: an uncaught throw there
    // takes the daemon down and every other shell's connection with it.
    const namesFile = join(dir, 'names.jsonl');
    writeFileSync(namesFile, `${JSON.stringify({ name: 'dep', line: 'docker compose up -d', cwds: [], ts: 1 })}\n`);
    await daemon();
    const client = await TestClient.connect(socketPath);
    // Touch the mtime so the host reloads, then make the read fail.
    writeFileSync(namesFile, `${JSON.stringify({ name: 'dep', line: 'docker compose up -d', cwds: [], ts: 2 })}\n`);
    chmodSync(namesFile, 0o000);
    try {
      const rows = await withTimeout(client.request('names', 'list', CWD, '', ''), 2_000, 'daemon died');
      expect(rows[0]?.[0]).toBeDefined();
      // Still alive and serving afterwards.
      expect((await client.request('ping'))[0]?.[0]).toBe('ok');
    } finally {
      chmodSync(namesFile, 0o600);
      client.close();
    }
  });

  it('reports a handle it could not persist instead of claiming success', async () => {
    // appendName is best-effort; a handle only in memory would be invisible to
    // every other shell and to the REPL.
    await daemon();
    const client = await TestClient.connect(socketPath);
    const lock = join(dir, 'names.jsonl.lock');
    mkdirSync(lock, { recursive: true });
    try {
      const rows = await client.request('names', 'create', CWD, 'dep', 'docker compose up -d');
      expect(rows[0]?.slice(0, 3)).toEqual(['err', 't1', 'bad_value']);
      expect(rows[0]?.[3]).toBe('not-saved');
    } finally {
      rmSync(lock, { recursive: true, force: true });
      client.close();
    }
  });

  it('keeps writing history after a transient lock failure', async () => {
    // The REPL, an import or a crashed process holds the lock for a moment —
    // latching on that would silently drop the rest of the session.
    await daemon();
    const client = await TestClient.connect(socketPath);
    const lock = `${historyFile}.lock`;
    mkdirSync(lock, { recursive: true });
    const blocked = await client.request('learn', '0', '1700000000000', CWD, 'while-locked');
    expect(blocked[0]?.[0]).toBe('err');
    rmSync(lock, { recursive: true, force: true });

    const after = await client.request('learn', '0', '1700000000001', CWD, 'after-unlock');
    expect(after[0]?.[0]).toBe('ok');
    expect(readFileSync(historyFile, 'utf8')).toContain('after-unlock');
    client.close();
  }, 30_000);

  it('shuts down when its socket is no longer reachable', async () => {
    // Something removed or replaced our socket file (a second daemon that
    // believed we were dead, a tmp cleaner). Nothing can reach us any more, so
    // squatting the model in memory until the idle timeout is pointless.
    // The check shares the idle timer, which ticks at idleTimeout/4.
    const handle = await daemon({ idleTimeoutMs: 8_000 });
    rmSync(socketPath, { force: true });
    await withTimeout(handle.closed, 6_000, 'daemon kept running with no reachable socket');
  });

  it('refuses to start a second daemon while the first is still warming', async () => {
    // build() blocks the event loop, so a warming daemon cannot answer a probe.
    // Declaring it dead would put two daemons on one history file.
    await daemon({ build: 'manual' });
    await expect(daemon({ build: 'manual' })).rejects.toBeInstanceOf(AlreadyRunningError);
  });
});

describe('daemon: protocol errors and limits', () => {
  it('echoes the id and a code for a malformed request', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    expect(await client.send(['predict', 'z9', String(PROTOCOL_VERSION), 'only-one-field'])).toEqual([
      ['err', 'z9', 'bad_fields', 'predict expects 7 fields, got 4'],
    ]);
    expect((await client.send(['nope', 'z8', String(PROTOCOL_VERSION)]))[0]?.[2]).toBe('bad_op');
    client.close();
  });

  it('rejects a foreign protocol version instead of guessing', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    const rows = await client.send(['ping', 'z1', '99']);
    expect(rows[0]?.slice(0, 3)).toEqual(['err', 'z1', 'bad_protocol']);
    expect(rows[0]?.[3]).toContain(`daemon speaks ${PROTOCOL_VERSION}`);
    client.close();
  });

  it('keeps the connection usable after an error', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);
    await client.send(['nope', 'z1', String(PROTOCOL_VERSION)]);
    expect((await client.request('ping'))[0]?.[0]).toBe('ok');
    client.close();
  });

  it('answers several pipelined requests in order', async () => {
    writeHistory(entry('git status'), entry('git status'));
    await daemon();
    const client = await TestClient.connect(socketPath);
    const answers = await Promise.all([client.request('ping'), client.request('predict', '1', '4', CWD, 'git ')]);
    expect(answers[0][0]?.[1]).toBe('t1');
    expect(answers[1][0]?.[1]).toBe('t2');
    client.close();
  });

  it('rejects an oversized request instead of buffering it', async () => {
    await daemon({ maxLineBytes: 256 });
    const client = await TestClient.connect(socketPath);
    const rows = await client.writeRaw('x'.repeat(300));
    expect(rows[0]?.slice(0, 3)).toEqual(['err', '-', 'too_long']);
    client.close();
  });

  it('rejects an oversized fragment that follows a newline in the same chunk', async () => {
    // The guard measured the whole buffer, so any earlier newline in the same
    // chunk let an unbounded fragment through.
    await daemon({ maxLineBytes: 256 });
    const client = await TestClient.connect(socketPath);
    // Both readers queued before the write: the daemon answers the complete
    // request first and complains about the leftover fragment second.
    const answered = client.writeRaw(`ping\tz1\t1\n${'x'.repeat(400)}`);
    const complaint = client.writeRaw('');
    expect((await withTimeout(answered, 2_000, 'no answer to the complete request'))[0]?.slice(0, 2)).toEqual([
      'ok',
      'z1',
    ]);
    expect((await withTimeout(complaint, 2_000, 'no answer to the oversized fragment'))[0]?.slice(0, 3)).toEqual([
      'err',
      '-',
      'too_long',
    ]);
    client.close();
  });

  it('turns away connections above the cap with a reply, not a silent RST', async () => {
    await daemon({ maxConnections: 1 });
    const first = await TestClient.connect(socketPath);
    expect((await first.request('ping'))[0]?.[0]).toBe('ok');

    const second = await TestClient.connect(socketPath);
    const rows = await withTimeout(second.request('ping'), 2_000, 'cap connection got no answer');
    expect(rows[0]?.slice(0, 3)).toEqual(['err', '-', 'busy']);

    // The slot frees up again once a shell disconnects.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await TestClient.connect(socketPath);
    expect((await third.request('ping'))[0]?.[0]).toBe('ok');
    third.close();
    second.close();
  });
});

describe('daemon: cross-process freshness', () => {
  it('sees entries another writer appended between two requests', async () => {
    writeHistory(entry('git status'));
    await daemon();
    const client = await TestClient.connect(socketPath);
    const before = await client.request('predict', '5', '4', CWD, 'npm ');
    expect(before.slice(1).map((row) => row[1])).not.toContain('run build');

    writeFileSync(historyFile, `${JSON.stringify(entry('git status'))}\n${JSON.stringify(entry('npm run build'))}\n`);
    const after = await client.request('predict', '5', '4', CWD, 'npm ');
    expect(after.slice(1).map((row) => row[1])).toContain('run build');
    client.close();
  });

  it('sees a handle another process wrote to names.jsonl', async () => {
    writeHistory(entry('git status'));
    await daemon();
    const client = await TestClient.connect(socketPath);
    const magic = { name: 'dep', line: 'docker compose up -d', cwds: [], ts: 1_700_000_050_000 };
    writeFileSync(join(dir, 'names.jsonl'), `${JSON.stringify(magic)}\n`);
    const rows = await client.request('predict', '5', '2', CWD, 'de');
    expect(rows.slice(1).map((row) => row[3])).toContain('dep');
    client.close();
  });
});
