import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_FILE, ROW, hasZsh, runZsh, splitRows, withPlugin, withPluginSetup } from './harness.js';

const zsh = hasZsh();

describe.skipIf(!zsh)('plugin: privacy filter', () => {
  const shouldLearn = (line: string, setup = '', env: Record<string, string> = {}): boolean => {
    const script = withPlugin(`${setup}\n_tabcat_should_learn $1 && print yes || print no`);
    return runZsh(script, { args: [line], env }).stdout.trim() === 'yes';
  };

  it('learns an ordinary command', () => {
    expect(shouldLearn('git status')).toBe(true);
  });

  it('skips a leading-space command when hist_ignore_space is set', () => {
    // The standard way to keep a secret out of the shell history. tabcat must
    // not undo that decision by writing it to its own history file.
    expect(shouldLearn('  export TOKEN=abc', 'setopt hist_ignore_space')).toBe(false);
  });

  it('learns a leading-space command when the option is off', () => {
    expect(shouldLearn('  export TOKEN=abc', 'unsetopt hist_ignore_space')).toBe(true);
  });

  it('honours a HISTORY_IGNORE pattern', () => {
    expect(shouldLearn('secret-tool print', 'HISTORY_IGNORE="(secret-tool*|ls)"')).toBe(false);
    expect(shouldLearn('git status', 'HISTORY_IGNORE="(secret-tool*|ls)"')).toBe(true);
  });

  it('honours hist_no_store for history and fc', () => {
    expect(shouldLearn('history', 'setopt hist_no_store')).toBe(false);
    expect(shouldLearn('fc -l', 'setopt hist_no_store')).toBe(false);
    expect(shouldLearn('historian --help', 'setopt hist_no_store')).toBe(true);
  });

  it('obeys TABCAT_NO_LEARN', () => {
    expect(shouldLearn('git status', '', { TABCAT_NO_LEARN: '1' })).toBe(false);
  });

  it('skips blank input', () => {
    expect(shouldLearn('')).toBe(false);
    expect(shouldLearn('   \t ')).toBe(false);
  });
});

describe.skipIf(!zsh)('plugin: buffer surgery', () => {
  const apply = (buffer: string, cursor: number, text: string, replace: number): string => {
    const script = withPlugin(`
      BUFFER=$1
      CURSOR=$2
      _tabcat_apply $3 $4
      print -rn -- "\${BUFFER}${ROW}\${CURSOR}${ROW}"
    `);
    const result = runZsh(script, { args: [buffer, String(cursor), text, String(replace)] });
    return splitRows(result.stdout).join('|');
  };

  it('appends when nothing is replaced', () => {
    expect(apply('git ', 4, 'status', 0)).toBe('git status|10');
  });

  it('replaces the typed prefix (case correction)', () => {
    expect(apply('cd doc', 6, 'Documents/', 3)).toBe('cd Documents/|13');
  });

  it('keeps text right of the cursor', () => {
    expect(apply('git  --force', 4, 'push', 0)).toBe('git push --force|8');
  });

  it('clamps a replace count larger than the cursor', () => {
    expect(apply('ab', 2, 'xyz', 99)).toBe('xyz|3');
  });
});

describe.skipIf(!zsh)('plugin: chunk splitting', () => {
  const chunk = (ghost: string): string => {
    const script = withPlugin(`
      local ghost=$1
      local lead=\${ghost%%[^[:space:]]*}
      local rest=\${ghost#$lead}
      local word=\${rest%%[[:space:]]*}
      local after=\${rest#$word}
      local trail=\${after%%[^[:space:]]*}
      print -rn -- "\${lead}\${word}\${trail}${ROW}"
    `);
    return splitRows(runZsh(script, { args: [ghost] })[0] ?? '');
  };

  it('takes the first word plus its trailing space', () => {
    const script = withPlugin(`
      _TABCAT_GHOST_TEXT=$1
      local ghost=$_TABCAT_GHOST_TEXT
      local lead=\${ghost%%[^[:space:]]*}
      local rest=\${ghost#$lead}
      local word=\${rest%%[[:space:]]*}
      local after=\${rest#$word}
      local trail=\${after%%[^[:space:]]*}
      print -rn -- "\${lead}\${word}\${trail}${ROW}"
    `);
    const first = (ghost: string): string => splitRows(runZsh(script, { args: [ghost] }).stdout)[0] ?? '';
    expect(first('run build --prod')).toBe('run ');
    expect(first(' status')).toBe(' status');
    expect(first('status')).toBe('status');
    expect(first(' -m "fix"')).toBe(' -m ');
  });

  void chunk;
});

describe.skipIf(!zsh)('plugin: load guards', () => {
  it('does nothing at all in a non-interactive shell', () => {
    // `zsh -c` without -i: a script sourcing the plugin must get no widgets,
    // no hooks and no socket traffic.
    const stdout = execFileSync('zsh', ['-f', '-c', `source ${PLUGIN_FILE}; print funcs=\${+functions[_tabcat_request]}; print hooks=\${#precmd_functions}`], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/tmp' },
    });
    expect(stdout.trim().split('\n')).toEqual(['funcs=0', 'hooks=0']);
  });
});

describe.skipIf(!zsh)('plugin: setup wiring', () => {
  const inspect = (body: string, options: { env?: Record<string, string>; pre?: string } = {}): string => {
    const script = `${options.pre ?? ''}\n${withPluginSetup(body)}`;
    const result = runZsh(script, options.env !== undefined ? { env: options.env } : {});
    return `${result.stdout}${result.stderr}`;
  };

  it('binds Tab, Enter and the ^X chords', () => {
    const out = inspect(`
      bindkey '^I'
      bindkey '^M'
      bindkey '^Xl'
      bindkey '^Xf'
      bindkey '^Xq'
      bindkey '^Xd'
    `);
    expect(out).toContain('"^I" tabcat-tab');
    expect(out).toContain('"^M" tabcat-accept-line');
    expect(out).toContain('"^Xl" tabcat-label');
    expect(out).toContain('"^Xf" tabcat-forget');
    expect(out).toContain('"^Xq" tabcat-query');
    expect(out).toContain('"^Xd" tabcat-menu');
  });

  it('leaves the zsh defaults on ^N, ^R and the ^X prefix alone', () => {
    // The whole reason for two-stroke chords: no muscle memory breaks.
    const out = inspect(`
      bindkey '^N'
      bindkey '^R'
      bindkey '^X^X'
      print "xchords=$(bindkey -p '^X' | wc -l | tr -d ' ')"
    `);
    expect(out).toContain('"^N" down-line-or-history');
    expect(out).toContain('"^R" history-incremental-search-backward');
    // The ^X prefix keymap survives: binding a bare ^X would have wiped it.
    expect(out).toContain('"^X^X" exchange-point-and-mark');
    expect(Number(/xchords=(\d+)/.exec(out)?.[1])).toBeGreaterThan(10);
  });

  it('wraps the editing widgets so the ghost can follow every keystroke', () => {
    const out = inspect(`
      print "self-insert=\${widgets[self-insert]}"
      print "backward-delete-char=\${widgets[backward-delete-char]}"
      print "orig-exists=\${+widgets[tabcat-orig-self-insert]}"
    `);
    expect(out).toContain('self-insert=user:_tabcat_wrapped_self-insert');
    expect(out).toContain('backward-delete-char=user:_tabcat_wrapped_backward-delete-char');
    expect(out).toContain('orig-exists=1');
  });

  it('does not touch completion widgets', () => {
    const out = inspect(`print "expand-or-complete=\${widgets[expand-or-complete]}"`);
    expect(out).toContain('expand-or-complete=builtin');
  });

  it('remembers whoever owned Tab before it', () => {
    const out = inspect('print "orig=$_TABCAT_ORIG_TAB"', {
      pre: `foreign-tab() { : }\nzle -N foreign-tab\nbindkey '^I' foreign-tab`,
    });
    expect(out).toContain('orig=foreign-tab');
  });

  it('puts its precmd hook first, even behind an existing prompt hook', () => {
    // starship and friends run a command inside precmd and destroy $?; only the
    // first hook sees the real exit code.
    const out = inspect('print "first=${precmd_functions[1]}"\nprint "all=${(j:,:)precmd_functions}"', {
      pre: 'fake_prompt_precmd() { : }\nprecmd_functions=(fake_prompt_precmd)',
    });
    expect(out).toContain('first=_tabcat_precmd');
    expect(out).toContain('all=_tabcat_precmd,fake_prompt_precmd');
  });

  it('skips a chord that is already taken and says so', () => {
    const out = inspect(`bindkey '^Xl'`, {
      pre: `foreign-label() { : }\nzle -N foreign-label\nbindkey '^Xl' foreign-label`,
    });
    expect(out).toContain('is already bound');
    expect(out).toContain('"^Xl" foreign-label');
  });

  it('takes a taken chord over with TABCAT_FORCE', () => {
    const out = inspect(`bindkey '^Xl'`, {
      pre: `foreign-label() { : }\nzle -N foreign-label\nbindkey '^Xl' foreign-label`,
      env: { TABCAT_FORCE: '1' },
    });
    expect(out).toContain('"^Xl" tabcat-label');
  });

  it('refuses to load next to zsh-autosuggestions unless forced', () => {
    const pre = '_zsh_autosuggest_start() { : }';
    const blocked = inspect('print "off=$_TABCAT_OFF"', { pre });
    expect(blocked).toContain('POSTDISPLAY');
    expect(blocked).toContain('off=1');

    const forced = inspect('print "off=$_TABCAT_OFF"', { pre, env: { TABCAT_FORCE: '1' } });
    expect(forced).toContain('off=0');
  });

  it('registers the learning hooks', () => {
    const out = inspect('print "preexec=${(j:,:)preexec_functions}"');
    expect(out).toContain('preexec=_tabcat_preexec');
  });
});

describe.skipIf(!zsh)('plugin: failure handling', () => {
  it('gives up quickly when no daemon can be started', () => {
    const dir = mkdtempSync('/tmp/tc-nodaemon-');
    try {
      const script = withPlugin(`
        _TABCAT_SOCKET=$1
        _tabcat_request ping && print "unexpected ok" || print "failed"
        print "off=$_TABCAT_OFF"
        print "fd=$_TABCAT_FD"
      `);
      const started = Date.now();
      const result = runZsh(script, {
        args: [join(dir, 'missing.sock')],
        env: { TABCAT_BIN: '/nonexistent/tabcat' },
      });
      const elapsed = Date.now() - started;
      expect(result.stdout).toContain('failed');
      expect(result.stdout).toContain('off=1');
      expect(result.stdout).toContain('fd=0');
      // The user's prompt must not stall while a daemon is missing.
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
