import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bashShell } from '../../src/engine/shell.js';
import { execute, warmShellSnapshot } from '../../src/repl/executor.js';
import { fuzzySearch } from '../../src/repl/history-search.js';

// Skip shell-dependent tests when the shell is missing on the machine
// (zsh: many Linux boxes/CI; bash: Windows) — instead of going red.
const hasZsh = !spawnSync('zsh', ['--version'], { stdio: 'ignore' }).error;
const hasBash = !spawnSync('bash', ['--version'], { stdio: 'ignore' }).error;

describe('executor', () => {
  it.skipIf(!hasZsh)('cwd persists across cd — also combined with &&', () => {
    const result = execute('cd /tmp && true', process.cwd());
    expect(result.cwd.endsWith('tmp')).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it.skipIf(!hasZsh)('exitCode is passed through, cwd stays on failure', () => {
    const cwd = process.cwd();
    const result = execute('false', cwd);
    expect(result.exitCode).toBe(1);
    expect(result.cwd).toBe(cwd);
  });

  it.skipIf(!hasZsh)('signal death becomes 128+signal number (SIGINT -> 130), not 0', () => {
    const result = execute('kill -INT $$', process.cwd());
    expect(result.exitCode).toBe(130);
  });

  it.skipIf(!hasBash)('bash adapter: execution + cwd persistence + expand_aliases preamble', () => {
    // bash must accept shopt in the preamble, otherwise even `true` fails.
    const result = execute('cd /tmp && true', process.cwd(), bashShell);
    expect(result.cwd.endsWith('tmp')).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it.skipIf(!hasBash)('snapshot isolates aliases from RC output and global state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tabcat-bash-home-'));
    writeFileSync(join(home, '.bashrc'), "echo RC-BANNER\nalias tabcat_test_alias='true'\n", 'utf8');

    try {
      const snapshot = await warmShellSnapshot(bashShell, { ...process.env, HOME: home });
      expect(snapshot).toContain("alias tabcat_test_alias='true'");
      expect(snapshot).not.toContain('RC-BANNER');
      expect(execute('type tabcat_test_alias >/dev/null 2>&1', process.cwd(), bashShell, snapshot ?? '').exitCode).toBe(0);
      expect(execute('type tabcat_test_alias >/dev/null 2>&1', process.cwd(), bashShell).exitCode).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('fuzzySearch (Ctrl-R)', () => {
  // Contract: newest first, already deduplicated.
  const recentFirst = ['vendor/bin/tool', 'git push', 'docker compose up', 'git status'];

  it('substring match, most recent first', () => {
    expect(fuzzySearch('git', recentFirst)[0]).toBe('git push');
  });

  it('subsequence matches even without a contiguous substring', () => {
    expect(fuzzySearch('vbt', recentFirst)).toContain('vendor/bin/tool');
  });

  it('empty query returns most recent commands', () => {
    expect(fuzzySearch('', recentFirst)[0]).toBe('vendor/bin/tool');
  });
});
