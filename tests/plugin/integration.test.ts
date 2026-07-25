import { Server, createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonHandle, startDaemon } from '../../src/daemon/server.js';
import { HistoryEntry } from '../../src/engine/model.js';
import { fileURLToPath } from 'node:url';
import { pidfileFor } from '../../src/daemon/paths.js';
import { ROW, hasZsh, runZshAsync, splitRows, withPlugin, withPluginSetup } from './harness.js';

const zsh = hasZsh();

let dir: string;
let socketDir: string;
let historyFile: string;
let socketPath: string;
let daemon: DaemonHandle | null = null;
let fake: Server | null = null;

const entry = (line: string, ts = 1_700_000_000_000): HistoryEntry => ({ ts, cwd: '/work', line });

beforeEach(() => {
  dir = mkdtempSync('/tmp/tc-int-');
  socketDir = mkdtempSync('/tmp/tc-ints-');
  historyFile = join(dir, 'history.jsonl');
  socketPath = join(socketDir, 'd.sock');
});

afterEach(async () => {
  if (daemon !== null) await daemon.close();
  daemon = null;
  if (fake !== null) await new Promise<void>((resolve) => fake?.close(() => resolve()));
  fake = null;
  rmSync(dir, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
});

const writeHistory = (...entries: readonly HistoryEntry[]): void =>
  writeFileSync(historyFile, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

async function startRealDaemon(): Promise<void> {
  daemon = await startDaemon({
    socketPath,
    historyFile,
    fs: { readdir: () => null },
    homeDir: '/home/test',
    build: 'sync',
  });
}

/** Accepts connections and answers with whatever `reply` returns (null = silence). */
function startFakeDaemon(reply: (id: string) => string | null): Promise<void> {
  fake = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line !== '') {
          const answer = reply(line.split('\t')[1] ?? '-');
          if (answer !== null) socket.write(answer);
        }
        newline = buffer.indexOf('\n');
      }
    });
  });
  return new Promise((resolve) => fake?.listen(socketPath, () => resolve()));
}

/**
 * Runs a plugin snippet against the daemon started above. Async on purpose: the
 * daemon lives in this process, and a synchronous child would deadlock it.
 * TABCAT_BIN points nowhere so a missing socket fails instead of silently
 * spawning a real daemon from the developer's PATH.
 */
const run = async (body: string, args: readonly string[] = []): Promise<{ stdout: string; stderr: string }> => {
  const script = withPlugin(`_TABCAT_SOCKET=${socketPath}\n${body}`);
  const result = await runZshAsync(script, { args, cwd: dir, env: { TABCAT_BIN: '/nonexistent/tabcat' } });
  return { stdout: result.stdout, stderr: result.stderr };
};

describe.skipIf(!zsh)('plugin against a live daemon', () => {
  it('predicts through the persistent fd', async () => {
    writeHistory(entry('git status'), entry('git status', 1_700_000_000_001));
    await startRealDaemon();
    const { stdout } = await run(`
      BUFFER="git " CURSOR=4
      _tabcat_predict 5 || { print "PREDICT FAILED"; return 1 }
      local _TABCAT_C_INSERT _TABCAT_C_DISPLAY _TABCAT_C_SOURCE _TABCAT_C_NAME _TABCAT_C_REPLACE
      _tabcat_candidate 2
      print -rn -- "\${_TABCAT_C_INSERT}${ROW}\${_TABCAT_C_DISPLAY}${ROW}\${_TABCAT_C_SOURCE}${ROW}\${_TABCAT_C_REPLACE}${ROW}"
    `);
    expect(splitRows(stdout)).toEqual(['status', 'status', 'history', '0']);
  });

  it('reuses one fd for many requests', async () => {
    writeHistory(entry('git status'), entry('git status', 1_700_000_000_001));
    await startRealDaemon();
    const { stdout } = await run(`
      BUFFER="git " CURSOR=4
      local first=0
      local i
      for i in 1 2 3 4 5; do
        _tabcat_predict 1 || { print "FAILED at $i"; return 1 }
        (( first == 0 )) && first=$_TABCAT_FD
        (( _TABCAT_FD == first )) || { print "fd changed: $first -> $_TABCAT_FD"; return 1 }
      done
      print "fd-stable seq=$_TABCAT_SEQ"
    `);
    expect(stdout.trim()).toBe('fd-stable seq=5');
  });

  it('escapes a command with tabs and backslashes end to end', async () => {
    await startRealDaemon();
    const nasty = "awk -F'\\t' '{print $1}' data\twith\ttabs";
    await run(
      `
      local REPLY line cwd
      _tabcat_esc $1; line=$REPLY
      _tabcat_esc $PWD; cwd=$REPLY
      _tabcat_request learn 0 1700000012345 $cwd $line || print "LEARN FAILED"
    `,
      [nasty],
    );
    const stored = JSON.parse(readFileSync(historyFile, 'utf8').trim()) as HistoryEntry;
    expect(stored.line).toBe(nasty);
  });

  it('learns from the precmd hook, including cwd and exit code', async () => {
    await startRealDaemon();
    await run(`
      _TABCAT_PENDING_LINE="npm run build"
      _TABCAT_PENDING_CWD=$PWD
      ( exit 3 )
      _tabcat_precmd
      print "pending=[$_TABCAT_PENDING_LINE]"
    `);
    const stored = JSON.parse(readFileSync(historyFile, 'utf8').trim()) as HistoryEntry;
    expect(stored.line).toBe('npm run build');
    expect(stored.exitCode).toBe(3);
    // realpath: on macOS /tmp is a symlink, and zsh reports the physical path.
    expect(stored.cwd).toBe(realpathSync(dir));
    expect(stored.ts).toBeGreaterThan(1_700_000_000_000);
  });

  it('does not learn a command the shell itself would hide', async () => {
    await startRealDaemon();
    await run(`
      setopt hist_ignore_space
      _TABCAT_PENDING_LINE="  export TOKEN=secret"
      _TABCAT_PENDING_CWD=$PWD
      _tabcat_precmd
    `);
    // Nothing written at all — the daemon never even created the file.
    expect(existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : '').toBe('');
  });

  it('creates and resolves a magic name', async () => {
    await startRealDaemon();
    const { stdout } = await run(`
      local REPLY cwd line
      _tabcat_esc $PWD; cwd=$REPLY
      _tabcat_esc "docker compose up -d"; line=$REPLY
      _tabcat_request names create $cwd dep $line || { print "CREATE FAILED"; return 1 }
      _tabcat_request names resolve $cwd dep '' || { print "RESOLVE FAILED"; return 1 }
      local -a header=("\${(@ps:\\t:)_TABCAT_ROWS[1]}")
      _tabcat_dec \${header[3]}
      print -rn -- "\${REPLY}${ROW}"
    `);
    expect(splitRows(stdout)).toEqual(['docker compose up -d']);
    expect(readFileSync(join(dir, 'names.jsonl'), 'utf8')).toContain('"name":"dep"');
  });

  it('shows the handle badge in the predict header', async () => {
    writeHistory(entry('docker compose up -d'), entry('docker compose up -d', 1_700_000_000_001));
    await startRealDaemon();
    const { stdout } = await run(`
      local REPLY cwd line
      _tabcat_esc $PWD; cwd=$REPLY
      _tabcat_esc "docker compose up -d"; line=$REPLY
      _tabcat_request names create $cwd dep $line || { print "CREATE FAILED"; return 1 }
      BUFFER="docker compose up -d" CURSOR=20
      _tabcat_predict 1 || { print "PREDICT FAILED"; return 1 }
      local REPLY
      _tabcat_header_handle
      print -r -- "handle=$REPLY"
    `);
    expect(stdout).toContain('handle=dep');
  });

  it('searches the history', async () => {
    writeHistory(entry('deploy production'), entry('git status', 1_700_000_000_001));
    await startRealDaemon();
    const { stdout } = await run(`
      local REPLY cwd query
      _tabcat_esc $PWD; cwd=$REPLY
      _tabcat_esc "depl"; query=$REPLY
      _tabcat_request search 5 $cwd $query || { print "SEARCH FAILED"; return 1 }
      _tabcat_dec \${_TABCAT_ROWS[2]}
      print -rn -- "\${REPLY}${ROW}"
    `);
    expect(splitRows(stdout)).toEqual(['deploy production']);
  });
});

describe.skipIf(!zsh)('plugin against a broken daemon', () => {
  it('times out instead of hanging the shell, and drops the fd', async () => {
    // Accepts the connection, never answers — the worst case for a synchronous
    // client sitting in the user's keystroke path.
    await startFakeDaemon(() => null);
    const started = Date.now();
    const { stdout } = await run(`
      _tabcat_request ping && print "unexpected ok" || print "failed"
      print "fd=$_TABCAT_FD"
      print "off=$_TABCAT_OFF"
    `);
    const elapsed = Date.now() - started;
    expect(stdout).toContain('failed');
    // The fd is unusable after a timeout: a late answer would be read as the
    // response to the next request.
    expect(stdout).toContain('fd=0');
    // Not disabled — a single slow answer is not a reason to give up.
    expect(stdout).toContain('off=0');
    expect(elapsed).toBeLessThan(3_000);
  });

  it('drops the fd when a response carries a foreign id', async () => {
    await startFakeDaemon(() => 'ok\tWRONG\t\n\n');
    const { stdout } = await run(`
      _tabcat_request ping && print "unexpected ok" || print "failed"
      print "fd=$_TABCAT_FD"
    `);
    expect(stdout).toContain('failed');
    expect(stdout).toContain('fd=0');
  });

  it('disables itself once on a protocol mismatch', async () => {
    await startFakeDaemon((id) => `err\t${id}\tbad_protocol\tdaemon speaks 99\n\n`);
    const { stdout, stderr } = await run(`
      _tabcat_request ping && print "unexpected ok" || print "failed"
      print "off=$_TABCAT_OFF"
      _tabcat_request ping && print "second ok" || print "second failed"
    `);
    expect(stdout).toContain('failed');
    expect(stdout).toContain('off=1');
    expect(stdout).toContain('second failed');
    expect(stderr).toContain('different protocol');
    // One warning, not one per keystroke.
    expect(stderr.match(/different protocol/g)).toHaveLength(1);
  });

  it('treats a warming daemon as a silent miss', async () => {
    await startFakeDaemon((id) => `err\t${id}\twarming\tpredictor is still building\n\n`);
    const { stdout, stderr } = await run(`
      BUFFER="git " CURSOR=4
      _tabcat_predict 1 && print "unexpected ok" || print "miss"
      print "off=$_TABCAT_OFF"
    `);
    expect(stdout).toContain('miss');
    // A cold start must not disable the plugin and must not warn.
    expect(stdout).toContain('off=0');
    expect(stderr).toBe('');
  });
});

describe.skipIf(!zsh)('plugin cold start', () => {
  /**
   * The whole auto-spawn path: plugin load starts a daemon, a later keystroke
   * finds it, and a second shell does not start a second one. This is the path
   * a user hits every morning, and it is only exercised with a real binary — so
   * the test builds a wrapper that runs the actual CLI against a temp history.
   */
  const wrapper = (): string => {
    const path = join(dir, 'tabcat');
    const cliPath = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
    writeFileSync(
      path,
      // Only --history is injected: the socket now comes from the plugin, which
      // passes --socket explicitly. Forcing it here too would hide whether that
      // path works and would make the CLI reject the duplicate option.
      `#!/bin/sh\nexec npx tsx ${cliPath} "$@" --history ${historyFile}\n`,
      { mode: 0o755 },
    );
    return path;
  };

  const runReal = (body: string): Promise<{ stdout: string; stderr: string }> =>
    runZshAsync(`${withPluginSetup(body)}`, {
      cwd: dir,
      env: {
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        TABCAT_SOCKET: socketPath,
        // Node needs a home for npx' cache.
        HOME: process.env['HOME'] ?? '/tmp',
      },
    }).then((result) => ({ stdout: result.stdout, stderr: result.stderr }));

  const killSpawnedDaemon = (): void => {
    const pidfile = pidfileFor(historyFile);
    if (!existsSync(pidfile)) return;
    const pid = Number(readFileSync(pidfile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  };

  afterEach(() => killSpawnedDaemon());

  it('starts a daemon on load and serves the first prediction', async () => {
    writeHistory(entry('git status --short'), entry('git status --short', 1_700_000_000_001));
    wrapper();
    const { stdout } = await runReal(`
      print "spawns=$_TABCAT_SPAWNS"
      # Wait for the daemon the plugin launched in the background.
      zmodload zsh/zselect
      for i in {1..250}; do [[ -S ${socketPath} ]] && break; zselect -t 2 2>/dev/null; done
      print "socket=$([[ -S ${socketPath} ]] && print yes || print no)"
      BUFFER="git " CURSOR=4
      # The model may still be building right after the socket appears.
      for i in {1..50}; do
        _tabcat_predict 1 && break
        zselect -t 4 2>/dev/null
      done
      if (( \${#_TABCAT_ROWS} > 1 )); then
        local _TABCAT_C_INSERT _TABCAT_C_DISPLAY _TABCAT_C_SOURCE _TABCAT_C_NAME _TABCAT_C_REPLACE
        _tabcat_candidate 2
        print "display=[$_TABCAT_C_DISPLAY]"
      else
        print "no-candidates off=$_TABCAT_OFF"
      fi
    `);
    expect(stdout).toContain('spawns=1');
    expect(stdout).toContain('socket=yes');
    expect(stdout).toContain('display=[status --short]');
  }, 90_000);

  it('does not start a second daemon when one is already listening', async () => {
    writeHistory(entry('git status --short'), entry('git status --short', 1_700_000_000_001));
    wrapper();
    await runReal(`
      zmodload zsh/zselect
      for i in {1..250}; do [[ -S ${socketPath} ]] && break; zselect -t 2 2>/dev/null; done
    `);
    const pidfile = pidfileFor(historyFile);
    const firstPid = readFileSync(pidfile, 'utf8').trim();

    const { stdout } = await runReal(`print "spawns=$_TABCAT_SPAWNS"`);
    // Socket present -> the warm-up must be a no-op.
    expect(stdout).toContain('spawns=0');
    expect(readFileSync(pidfile, 'utf8').trim()).toBe(firstPid);
  }, 90_000);
});
