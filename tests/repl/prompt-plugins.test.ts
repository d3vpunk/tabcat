import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROMPT_PLUGINS } from '../../src/repl/prompt-plugins.js';

const gitPlugin = PROMPT_PLUGINS.find((plugin) => plugin.id === 'git')!;
const clockPlugin = PROMPT_PLUGINS.find((plugin) => plugin.id === 'clock')!;
const hasGit = spawnSync('git', ['--version']).status === 0;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tabcat-prompt-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function init(): void {
  git('init', '-b', 'main');
  git('config', 'user.email', 'prompt@example.test');
  git('config', 'user.name', 'Prompt Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(root, 'no-hooks'));
}

function commit(text = 'base\n'): void {
  writeFileSync(join(root, 'file'), text);
  git('add', 'file');
  git('commit', '-m', text.trim());
}

function collect(cwd = root, signal = new AbortController().signal) {
  return gitPlugin.collect({ cwd, signal });
}

function fakeGit(source: string): void {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  vi.stubEnv('PATH', bin);
}

describe('prompt registry', () => {
  it('has unique IDs and the bundled defaults', () => {
    expect(new Set(PROMPT_PLUGINS.map((plugin) => plugin.id)).size).toBe(PROMPT_PLUGINS.length);
    expect(gitPlugin.defaultEnabled).toBe(true);
    expect(clockPlugin.defaultEnabled).toBe(false);
    expect(clockPlugin.intervalMs).toBe(60_000);
  });

  it('formats the clock as local HH:mm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4));
    expect(await clockPlugin.collect({ cwd: root, signal: new AbortController().signal }))
      .toEqual({ text: '03:04', tone: 'muted', side: 'right' });
  });

  it('returns null when git is missing', async () => {
    vi.stubEnv('PATH', root);
    expect(await collect()).toBeNull();
  });

  it('honors an already cancelled collection', async () => {
    expect(await collect(root, AbortSignal.abort())).toBeNull();
  });

  it('cancels a running subprocess', async () => {
    fakeGit('setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const pending = collect(root, controller.signal);
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      expect(await pending).toBeNull();
    } finally {
      clearTimeout(timer);
    }
  });

  it('times out a stalled git command', async () => {
    fakeGit('setInterval(() => {}, 1000);');
    const start = Date.now();
    expect(await collect()).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
    expect(Date.now() - start).toBeLessThan(4000);
  });

  it('bounds git output', async () => {
    fakeGit("process.stdout.write('x'.repeat(300 * 1024));");
    expect(await collect()).toBeNull();
  });
});

describe.skipIf(!hasGit)('git prompt', () => {
  it('returns null outside repositories', async () => {
    expect(await collect()).toBeNull();
  });

  it('shows unborn and clean branches, and marks untracked and staged files dirty', async () => {
    init();
    expect(await collect()).toEqual({ text: 'main ✓', tone: 'success', side: 'left', highlight: { start: 5, end: 6 } });
    writeFileSync(join(root, 'file'), 'base\n');
    expect(await collect()).toMatchObject({ text: 'main ●', tone: 'warning', highlight: { start: 5, end: 6 } });
    git('add', 'file');
    expect((await collect())?.text).toBe('main ●');
    commit();
    expect((await collect())?.text).toBe('main ✓');
    writeFileSync(join(root, 'file'), 'changed\n');
    expect((await collect())?.text).toBe('main ●');
  });

  it('shows a short oid for detached HEAD', async () => {
    init();
    commit();
    git('checkout', '--detach');
    const oid = git('rev-parse', 'HEAD').slice(0, 7);
    expect(await collect()).toMatchObject({ text: `${oid} ◇ detached`, tone: 'warning' });
    writeFileSync(join(root, 'file'), 'changed\n');
    expect((await collect())?.text).toBe(`${oid} ● detached`);
  });

  it('reports untracked files even when user status configuration hides them', async () => {
    init();
    commit();
    git('config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(root, 'untracked'), 'new file\n');
    expect(await collect()).toMatchObject({ text: 'main ●', tone: 'warning' });
  });

  it('shows ahead and behind counts without contacting a remote', async () => {
    init();
    commit();
    git('branch', 'upstream');
    git('branch', '--set-upstream-to=upstream');
    commit('ahead\n');
    git('checkout', 'upstream');
    commit('behind\n');
    git('checkout', 'main');
    expect(await collect()).toMatchObject({ text: 'main ✓ ↑1 ↓1', tone: 'success', highlight: { start: 5, end: 6 } });
  });

  it('warns about merge conflicts', async () => {
    init();
    commit();
    git('checkout', '-b', 'other');
    commit('other\n');
    git('checkout', 'main');
    commit('main\n');
    expect(() => git('merge', 'other')).toThrow();
    expect(await collect()).toEqual({ text: 'main ! conflict', tone: 'error', side: 'left', highlight: { start: 5, end: 15 } });
  });

  it.each(['rebase-merge', 'rebase-apply', 'MERGE_HEAD'])('finds %s in a linked worktree', async (marker) => {
    init();
    commit();
    const worktree = join(root, 'linked');
    git('worktree', 'add', '-b', 'linked', worktree);
    const path = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', marker],
      { cwd: worktree, encoding: 'utf8' }).trim();
    if (marker === 'MERGE_HEAD') writeFileSync(path, `${git('rev-parse', 'HEAD')}\n`);
    else mkdirSync(path);
    writeFileSync(join(worktree, 'file'), 'changed\n');
    expect(await collect(worktree)).toEqual({
      text: `linked ${marker === 'MERGE_HEAD' ? '↔ merge' : '↻ rebase'}`,
      tone: 'warning',
      highlight: { start: 7, end: marker === 'MERGE_HEAD' ? 14 : 15 },
      side: 'left',
    });
  });

  it('strips control formatting from branch names', async () => {
    init();
    git('checkout', '-b', 'safe\u202ename');
    expect(await collect()).toMatchObject({ text: 'safename ✓', highlight: { start: 9, end: 10 } });
  });
});
