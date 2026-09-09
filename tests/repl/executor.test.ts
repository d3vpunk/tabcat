import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bashShell, zshShell } from '../../src/engine/shell.js';
import { execute, seedLine, warmShellSnapshot } from '../../src/repl/executor.js';
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

  it.skipIf(!hasZsh)('seeds tabcat history so zsh `fc`/`history` list past commands', () => {
    const seeded = ['git status', 'npm run build', 'tabcat_marker_cmd'];
    // fc -l reads the loaded event list; grep sets the exit code without
    // needing to capture the inherited stdout.
    expect(execute('fc -l | grep -q tabcat_marker_cmd', process.cwd(), zshShell, '', seeded).exitCode).toBe(0);
    // Without a seed the exec shell has no events -> fc lists nothing.
    expect(execute('fc -l | grep -q tabcat_marker_cmd', process.cwd(), zshShell, '', []).exitCode).not.toBe(0);
  });

  it.skipIf(!hasBash)('seeds tabcat history so bash `history` lists past commands', () => {
    const seeded = ['git status', 'npm run build', 'tabcat_marker_cmd'];
    expect(execute('history | grep -q tabcat_marker_cmd', process.cwd(), bashShell, '', seeded).exitCode).toBe(0);
    expect(execute('history | grep -q tabcat_marker_cmd', process.cwd(), bashShell, '', []).exitCode).not.toBe(0);
  });

  it.skipIf(!hasBash)('bash adapter: execution + cwd persistence + expand_aliases preamble', () => {
    // bash must accept shopt in the preamble, otherwise even `true` fails.
    const result = execute('cd /tmp && true', process.cwd(), bashShell);
    expect(result.cwd.endsWith('tmp')).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it.skipIf(!hasBash)('snapshot captures aliases and functions, isolated from RC output', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tabcat-bash-home-'));
    writeFileSync(
      join(home, '.bashrc'),
      "echo RC-BANNER\nalias tabcat_test_alias='true'\ntabcat_test_fn(){ return 0; }\n_tabcat_priv(){ return 0; }\n",
      'utf8',
    );

    try {
      const snapshot = await warmShellSnapshot(bashShell, { ...process.env, HOME: home });
      expect(snapshot).not.toBeNull();
      const dump = readFileSync(snapshot!.file, 'utf8');
      expect(dump).toContain("alias tabcat_test_alias='true'");
      expect(dump).toContain('tabcat_test_fn');
      expect(dump).not.toContain('RC-BANNER'); // rc stdout does not leak into the snapshot
      expect(dump).not.toContain('_tabcat_priv'); // _* functions filtered out

      // Both an alias-backed and a function-backed command work through execute.
      expect(execute('type tabcat_test_alias >/dev/null 2>&1', process.cwd(), bashShell, snapshot!.file).exitCode).toBe(0);
      expect(execute('tabcat_test_fn', process.cwd(), bashShell, snapshot!.file).exitCode).toBe(0);
      // Without the snapshot the function does not exist.
      expect(execute('tabcat_test_fn', process.cwd(), bashShell).exitCode).not.toBe(0);

      snapshot!.cleanup();
      expect(existsSync(snapshot!.file)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasZsh)('zsh snapshot makes a function-backed command runnable (the omz history case)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tabcat-zsh-home-'));
    // Mirror oh-my-zsh: an alias that points at a shell function.
    writeFileSync(join(home, '.zshrc'), "tabcat_fn(){ return 0; }\nalias tabcat_wrapped='tabcat_fn'\n", 'utf8');

    try {
      const snapshot = await warmShellSnapshot(zshShell, { ...process.env, HOME: home, ZDOTDIR: home });
      expect(snapshot).not.toBeNull();
      expect(execute('tabcat_wrapped', process.cwd(), zshShell, snapshot!.file).exitCode).toBe(0);
      // Without the snapshot the alias -> function chain is gone.
      expect(execute('tabcat_wrapped', process.cwd(), zshShell).exitCode).not.toBe(0);
      snapshot!.cleanup();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasZsh)('zsh snapshot survives a function whose name is also a default alias', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tabcat-zsh-home-'));
    // zsh ships `run-help` as a DEFAULT alias, and rc files routinely autoload a
    // function of the same name — so the snapshot holds both. Loading it must not
    // abort at that definition: zsh refuses to define a function over an alias,
    // and everything after that line would be silently lost. The dump is
    // alphabetical, so `tabcat_fn` sits after `run-help` and proves the point.
    writeFileSync(join(home, '.zshrc'), 'autoload -Uz run-help\ntabcat_fn(){ return 0 }\n', 'utf8');

    try {
      const snapshot = await warmShellSnapshot(zshShell, { ...process.env, HOME: home, ZDOTDIR: home });
      expect(snapshot).not.toBeNull();
      const dump = readFileSync(snapshot!.file, 'utf8');
      // Assert the fixture really reproduces the collision — otherwise this test
      // would pass for the wrong reason.
      expect(dump).toMatch(/^alias run-help=/m);
      expect(dump).toMatch(/^run-help \(\)/m);

      expect(execute('tabcat_fn', process.cwd(), zshShell, snapshot!.file).exitCode).toBe(0);
      snapshot!.cleanup();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('history seed collapsing (seedLine)', () => {
  it('joins backslash continuations into one command', () => {
    expect(seedLine("curl 'x' \\\n  -X 'OPTIONS' \\\n  -H 'a: b'")).toBe("curl 'x' -X 'OPTIONS' -H 'a: b'");
  });

  it('separates real newlines with ; so the collapsed line stays valid shell', () => {
    expect(seedLine('echo 1\necho 2')).toBe('echo 1; echo 2');
    expect(seedLine('cd x \\\n  && make\nls -la')).toBe('cd x && make; ls -la');
  });

  it('leaves single-line entries untouched', () => {
    expect(seedLine('git status')).toBe('git status');
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
