import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Runs the real CLI through tsx — the same entry point users get as `tabcat`. */
function cli(args: readonly string[]): Promise<CliResult> {
  const child = spawn('npx', ['tsx', CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  return new Promise((resolve) => {
    child.on('close', (status) => resolve({ stdout, stderr, status: status ?? 1 }));
  });
}

describe('tabcat settings end to end', () => {
  let dir: string;
  let historyFile: string;
  let settingsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tabcat-cli-settings-'));
    historyFile = join(dir, 'history.jsonl');
    settingsFile = join(dir, 'settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('set, get, list and reset against a scratch settings file', async () => {
    const set = await cli(['settings', 'set', 'repl.dropdownRows', '8', '--history', historyFile]);
    expect(set.status).toBe(0);
    expect(set.stdout.trim()).toBe('repl.dropdownRows = 8');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ repl: { dropdownRows: 8 } });

    const get = await cli(['settings', 'get', 'repl.dropdownRows', '--history', historyFile]);
    expect(get.stdout.trim()).toBe('8'); // plain value — scriptable

    const list = await cli(['settings', 'list', '--history', historyFile]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('repl.dropdownRows');
    expect(list.stdout).toContain('repl.footer');
    expect(list.stdout).toMatch(/repl\.dropdownRows\s+8\s+\*/); // the changed marker
    expect(list.stdout).toContain(settingsFile);

    const reset = await cli(['settings', 'reset', 'repl.dropdownRows', '--history', historyFile]);
    expect(reset.stdout.trim()).toBe('repl.dropdownRows = 5 (default)');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({});
  }, 30_000);

  it('rejects invalid values and unknown keys with exit code 1', async () => {
    const invalid = await cli(['settings', 'set', 'repl.dropdownRows', '99', '--history', historyFile]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('expected an integer between 1 and 20');

    const unknown = await cli(['settings', 'get', 'no.such', '--history', historyFile]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown setting: no.such');
  }, 30_000);
});
