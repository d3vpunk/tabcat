import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonHandle, DaemonOptions, startDaemon } from '../../src/daemon/server.js';
import { PROTOCOL_VERSION, parseRequest } from '../../src/daemon/protocol.js';
import { SETTINGS } from '../../src/settings/schema.js';
import { settingsFileFor } from '../../src/settings/store.js';
import { TestClient } from './helpers.js';

const NO_FS = { readdir: () => null, isDirectory: () => false };

describe('settings request parsing', () => {
  const line = (...tail: readonly string[]): string => ['settings', 'p1', String(PROTOCOL_VERSION), ...tail].join('\t');

  it('parses list, set and reset', () => {
    expect(parseRequest(line('list', '', ''))).toEqual({
      ok: true,
      request: { op: 'settings', id: 'p1', sub: 'list', key: '', value: '' },
    });
    expect(parseRequest(line('set', 'repl.footer', 'false'))).toEqual({
      ok: true,
      request: { op: 'settings', id: 'p1', sub: 'set', key: 'repl.footer', value: 'false' },
    });
    expect(parseRequest(line('reset', 'repl.footer', ''))).toEqual({
      ok: true,
      request: { op: 'settings', id: 'p1', sub: 'reset', key: 'repl.footer', value: '' },
    });
  });

  it('rejects a wrong shape at the protocol layer', () => {
    expect(parseRequest(['settings', 'p1', String(PROTOCOL_VERSION), 'list'].join('\t'))).toMatchObject({
      ok: false,
      code: 'bad_fields',
    });
    expect(parseRequest(line('wat', 'k', 'v'))).toMatchObject({ ok: false, code: 'bad_value' });
    expect(parseRequest(line('set', '', 'v'))).toMatchObject({ ok: false, code: 'bad_value' });
    expect(parseRequest(line('reset', '', ''))).toMatchObject({ ok: false, code: 'bad_value' });
  });
});

describe('daemon: settings op', () => {
  let dir: string;
  let socketDir: string;
  let historyFile: string;
  let settingsFile: string;
  let socketPath: string;
  let running: DaemonHandle[] = [];

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
    dir = mkdtempSync(join(tmpdir(), 'tabcat-daemon-settings-'));
    socketDir = mkdtempSync('/tmp/tc-set-');
    historyFile = join(dir, 'history.jsonl');
    settingsFile = settingsFileFor(historyFile);
    socketPath = join(socketDir, 'daemon.sock');
  });

  afterEach(async () => {
    for (const handle of running) await handle.close();
    running = [];
    rmSync(dir, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  });

  it('list carries the whole schema: type, value, default, constraint, texts, live, overridden', async () => {
    writeFileSync(settingsFile, JSON.stringify({ repl: { dropdownRows: 9 } }));
    await daemon();
    const client = await TestClient.connect(socketPath);
    const rows = await client.request('settings', 'list', '', '');
    client.close();

    expect(rows[0]).toEqual(['ok', 't1']);
    expect(rows.length).toBe(1 + SETTINGS.length);
    const byKey = new Map(rows.slice(1).map((row) => [row[0], row]));
    expect(byKey.get('repl.dropdownRows')).toEqual([
      'repl.dropdownRows',
      'int',
      '9',
      '5',
      '1..20',
      'Dropdown rows',
      'How many candidate rows the REPL dropdown shows at once.',
      '1',
      '1',
      '1',
    ]);
    expect(byKey.get('repl.footer')).toEqual([
      'repl.footer',
      'bool',
      'true',
      'true',
      '',
      'Footer legend',
      'The key-hint line under the REPL prompt.',
      '1',
      '0',
      '',
    ]);
    expect(byKey.get('gui.launcherWidth')?.slice(2, 5)).toEqual(['1200', '1200', '700..2400']);
    expect(byKey.get('gui.launcherWidth')?.[9]).toBe('50'); // stepper affordance
  });

  it('set validates through the schema, writes the file and echoes the value', async () => {
    await daemon();
    const client = await TestClient.connect(socketPath);

    expect(await client.request('settings', 'set', 'repl.footer', 'false')).toEqual([['ok', 't1', 'false']]);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ repl: { footer: false } });

    const invalid = await client.request('settings', 'set', 'repl.dropdownRows', '99');
    expect(invalid).toEqual([['err', 't2', 'bad_value', 'repl.dropdownRows: expected an integer between 1 and 20']]);

    const unknown = await client.request('settings', 'set', 'no.such', '1');
    expect(unknown).toEqual([['err', 't3', 'bad_value', 'unknown setting: no.such']]);
    client.close();

    // The failed requests never touched the file.
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ repl: { footer: false } });
  });

  it('reset removes the override and echoes the default', async () => {
    writeFileSync(settingsFile, JSON.stringify({ repl: { footer: false } }));
    await daemon();
    const client = await TestClient.connect(socketPath);
    expect(await client.request('settings', 'reset', 'repl.footer', '')).toEqual([['ok', 't1', 'true']]);
    client.close();
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({});
  });

  it('answers while the model is still warming — settings never touch the predictor', async () => {
    const handle = await daemon({ build: 'manual' });
    expect(handle.host.state).toBe('warming');
    const client = await TestClient.connect(socketPath);
    const rows = await client.request('settings', 'list', '', '');
    expect(rows[0]).toEqual(['ok', 't1']);
    client.close();
  });

  it('a broken settings file: list answers defaults, set refuses without clobbering', async () => {
    writeFileSync(settingsFile, '{ not json');
    const warnings: string[] = [];
    await daemon({ onWarn: (message) => warnings.push(message) });
    const client = await TestClient.connect(socketPath);

    const rows = await client.request('settings', 'list', '', '');
    const dropdown = rows.slice(1).find((row) => row[0] === 'repl.dropdownRows');
    expect(dropdown?.[2]).toBe('5'); // default, not garbage
    expect(warnings.some((warning) => warning.includes('not valid JSON'))).toBe(true);

    const refused = await client.request('settings', 'set', 'repl.footer', 'false');
    expect(refused[0]?.slice(0, 3)).toEqual(['err', 't2', 'internal']);
    client.close();
    expect(readFileSync(settingsFile, 'utf8')).toBe('{ not json');
  });
});
