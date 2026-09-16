import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

export interface PromptSegment {
  text: string;
  tone: 'muted' | 'success' | 'warning' | 'error';
  /** Only this range receives the tone; surrounding context stays neutral. */
  highlight?: { start: number; end: number };
  side: 'left' | 'right';
}

export interface PromptPlugin {
  id: string;
  defaultEnabled: boolean;
  intervalMs?: number;
  collect(context: { cwd: string; signal: AbortSignal }): Promise<PromptSegment | null>;
}

const execFileAsync = promisify(execFile);

export const PROMPT_PLUGINS: readonly PromptPlugin[] = [
  {
    id: 'git',
    defaultEnabled: true,
    async collect({ cwd, signal }) {
      try {
        if (signal.aborted) return null;
        const options = {
          cwd,
          signal,
          timeout: 1500,
          maxBuffer: 256 * 1024,
          encoding: 'utf8' as const,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        };
        const [status, paths] = await Promise.all([
          execFileAsync('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], options),
          execFileAsync('git', [
            'rev-parse', '--path-format=absolute',
            '--git-path', 'MERGE_HEAD',
            '--git-path', 'rebase-merge',
            '--git-path', 'rebase-apply',
          ], options),
        ]);
        const gitPaths = paths.stdout.trimEnd().split('\n');
        if (gitPaths.length !== 3) return null;
        const [merge, rebaseMerge, rebaseApply] = await Promise.all(gitPaths.map(async (path) => {
          try {
            await stat(path);
            return true;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') return false;
            throw error;
          }
        }));
        let branch = '';
        let oid = '';
        let dirty = false;
        let conflict = false;
        let divergence = '';
        for (const line of status.stdout.split('\n')) {
          if (line.startsWith('# branch.head ')) branch = line.slice(14);
          else if (line.startsWith('# branch.oid ')) oid = line.slice(13);
          else if (line.startsWith('# branch.ab ')) {
            const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
            if (counts) {
              if (Number(counts[1])) divergence += ` ↑${counts[1]}`;
              if (Number(counts[2])) divergence += ` ↓${counts[2]}`;
            }
          } else if (/^[12u?] /.test(line)) {
            dirty = true;
            if (line.startsWith('u ')) conflict = true;
          }
        }
        if (!branch || signal.aborted) return null;
        const detached = branch === '(detached)';
        if (detached) branch = oid.slice(0, 7);
        // Strip terminal controls and bidi formatting from repository-owned text.
        branch = branch.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '');
        const marker = conflict ? '! conflict'
          : rebaseMerge || rebaseApply ? '↻ rebase'
          : merge ? '↔ merge'
          : dirty ? `●${detached ? ' detached' : ''}`
          : detached ? '◇ detached' : '✓';
        return {
          text: `${branch} ${marker}${divergence}`,
          tone: conflict ? 'error' : marker === '✓' ? 'success' : 'warning',
          highlight: { start: branch.length + 1, end: branch.length + 1 + marker.length },
          side: 'left',
        };
      } catch {
        return null;
      }
    },
  },
  {
    id: 'clock',
    defaultEnabled: false,
    intervalMs: 60_000,
    async collect({ signal }) {
      if (signal.aborted) return null;
      const now = new Date();
      const text = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      return { text, tone: 'muted', side: 'right' };
    },
  },
];
