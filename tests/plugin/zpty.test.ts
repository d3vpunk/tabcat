import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonHandle, startDaemon } from '../../src/daemon/server.js';
import { HistoryEntry } from '../../src/engine/model.js';
import { PLUGIN_FILE, hasZsh, runZshAsync } from './harness.js';

const zsh = hasZsh();

let dir: string;
let socketDir: string;
let historyFile: string;
let socketPath: string;
let probeFile: string;
let daemon: DaemonHandle | null = null;

const entry = (line: string, ts: number): HistoryEntry => ({ ts, cwd: '/seed', line });

beforeEach(() => {
  // realpath: the pty shell reports the physical path, and cwd comparisons plus
  // magic-name lookups are exact string matches.
  dir = realpathSync(mkdtempSync('/tmp/tc-pty-'));
  socketDir = mkdtempSync('/tmp/tc-ptys-');
  historyFile = join(dir, 'history.jsonl');
  socketPath = join(socketDir, 'd.sock');
  probeFile = join(dir, 'probe.txt');
});

afterEach(async () => {
  if (daemon !== null) await daemon.close();
  daemon = null;
  rmSync(dir, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
});

const writeHistory = (...entries: readonly HistoryEntry[]): void =>
  writeFileSync(historyFile, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));

async function startRealDaemon(): Promise<void> {
  daemon = await startDaemon({ socketPath, historyFile, homeDir: dir, build: 'sync' });
}

const probe = (): string[] =>
  existsSync(probeFile) ? readFileSync(probeFile, 'utf8').trim().split('\n').filter(Boolean) : [];

/**
 * Drives the plugin inside a real pseudo terminal — the only way to exercise key
 * bindings, ZLE state and POSTDISPLAY for real.
 *
 * Assertions never scrape the terminal: a `^Xz` probe widget appends the exact
 * ZLE state to a file, and side effects on disk carry the rest. Screen scraping
 * is what makes pty tests flaky — the redraw stream is full of cursor motions
 * that hide the very text one wants to match.
 */
const prelude = (learn: boolean, term: string): string => `
zmodload zsh/zpty || { print "NO-ZPTY"; exit 2 }
zmodload zsh/datetime
zmodload zsh/zselect

# Drains pty output for a fixed time. Deliberately no pattern matching: the
# shell echoes input, redraws with cursor motions and prints its prompt, so the
# probe file is the reliable observation channel.
pump() {
  local chunk
  local -F deadline=$(( EPOCHREALTIME + $1 ))
  while (( EPOCHREALTIME < deadline )); do
    zpty -r -t tc chunk 2>/dev/null || zselect -t 2 2>/dev/null
  done
  return 0
}

# Line count of the probe file. \`$(<file)\` is optimised by zsh into a plain
# read, so polling this costs no forks.
probe_count() {
  local -a captured=(\${(f)"$(<${probeFile} 2>/dev/null)"})
  PROBE_N=\${#captured}
}

# Waits until the probe widget appended a line, instead of guessing how long a
# round trip takes. Deadlines instead of fixed sleeps: fast when the machine is
# idle, still correct when the CI box is loaded.
press_highlight_probe() {
  local before
  probe_count; before=$PROBE_N
  zpty -w -n tc $'\\C-Xh'
  local -F deadline=$(( EPOCHREALTIME + 10 ))
  while (( EPOCHREALTIME < deadline )); do
    pump 0.05
    probe_count
    (( PROBE_N > before )) && return 0
  done
  print "HL-PROBE-TIMEOUT"
  return 1
}

press_probe() {
  local before
  probe_count; before=$PROBE_N
  zpty -w -n tc $'\\C-Xz'
  local -F deadline=$(( EPOCHREALTIME + 10 ))
  while (( EPOCHREALTIME < deadline )); do
    pump 0.05
    probe_count
    (( PROBE_N > before )) && return 0
  done
  print "PROBE-TIMEOUT"
  return 1
}

wait_for_file() {
  local -F deadline=$(( EPOCHREALTIME + 10 ))
  while (( EPOCHREALTIME < deadline )); do
    [[ -e $1 ]] && return 0
    pump 0.05
  done
  print "FILE-TIMEOUT $1"
  return 1
}

wait_for_text() {
  local -F deadline=$(( EPOCHREALTIME + 10 ))
  while (( EPOCHREALTIME < deadline )); do
    [[ -e $1 && "$(<$1)" == *$2* ]] && return 0
    pump 0.05
  done
  print "TEXT-TIMEOUT $2"
  return 1
}

pty_start() {
  zpty tc "TERM=${term} TABCAT_SOCKET=${socketPath}${learn ? '' : ' TABCAT_NO_LEARN=1'} zsh -f -i" || return 1
  pump 0.5
  zpty -w tc "cd ${dir}"
  zpty -w tc "source ${PLUGIN_FILE}"
  zpty -w tc 'tabcat-probe() { print -r -- "buf=[$BUFFER] cur=$CURSOR post=[$POSTDISPLAY] off=$_TABCAT_OFF" >> ${probeFile} }; zle -N tabcat-probe; bindkey "^Xz" tabcat-probe'
  zpty -w tc 'tabcat-probe-hl() { print -r -- "hl=$#region_highlight items=(\${(j:|:)region_highlight})" >> ${probeFile} }; zle -N tabcat-probe-hl; bindkey "^Xh" tabcat-probe-hl'
  # The probe widget must exist before any test relies on it.
  local -F deadline=$(( EPOCHREALTIME + 10 ))
  while (( EPOCHREALTIME < deadline )); do
    pump 0.1
    zpty -w -n tc $'\\C-Xz'
    pump 0.1
    probe_count
    (( PROBE_N > 0 )) && { : > ${probeFile}; return 0 }
  done
  print "NO-PROBE-WIDGET"
  return 1
}

type_keys() { zpty -w -n tc "$1"; pump \${2:-0.4} }
press_enter() { zpty -w -n tc $'\\r'; pump \${1:-0.2} }
`;

const runPty = async (body: string, options: { learn?: boolean; term?: string } = {}): Promise<string> => {
  const script = `${prelude(options.learn === true, options.term ?? 'xterm-256color')}\n${body}`;
  if (process.env['TABCAT_DUMP_PTY_SCRIPT'] !== undefined) writeFileSync(process.env['TABCAT_DUMP_PTY_SCRIPT'], script);
  const result = await runZshAsync(script, {
    cwd: dir,
    // Nothing may fall back to a daemon from the developer's PATH.
    env: { TABCAT_BIN: '/nonexistent/tabcat' },
  });
  return `${result.stdout}${result.stderr}`;
};

describe.skipIf(!zsh)('plugin in a pseudo terminal', { timeout: 60_000 }, () => {
  it('renders the suggestion as ghost text and accepts it on Tab', async () => {
    writeHistory(
      entry('touch tab-accepted.marker', 1_700_000_000_000),
      entry('touch tab-accepted.marker', 1_700_000_000_001),
    );
    await startRealDaemon();
    await runPty(`
      pty_start || exit 1
      type_keys 'touch tab-'
      press_probe
      type_keys $'\\t'
      press_probe
      press_enter
      wait_for_file ${dir}/tab-accepted.marker
      zpty -d tc
    `);
    const [beforeTab, afterTab] = probe();
    // Ghost visible, buffer untouched.
    expect(beforeTab).toBe('buf=[touch tab-] cur=10 post=[accepted.marker] off=0');
    // Tab merged the candidate in and cleared the ghost it consumed.
    expect(afterTab).toBe('buf=[touch tab-accepted.marker] cur=25 post=[] off=0');
    expect(existsSync(join(dir, 'tab-accepted.marker'))).toBe(true);
  });

  it('accepts a single chunk on the right arrow key', async () => {
    writeHistory(
      entry('touch chunk-one chunk-two', 1_700_000_000_000),
      entry('touch chunk-one chunk-two', 1_700_000_000_001),
    );
    await startRealDaemon();
    await runPty(`
      pty_start || exit 1
      type_keys 'touch '
      press_probe
      type_keys $'\\e[C'
      press_probe
      press_enter
      wait_for_file ${dir}/chunk-one
      zpty -d tc
    `);
    const [, afterArrow] = probe();
    // One chunk in, the rest still ghosted.
    expect(afterArrow).toBe('buf=[touch chunk-one ] cur=16 post=[chunk-two] off=0');
    expect(existsSync(join(dir, 'chunk-one'))).toBe(true);
    expect(existsSync(join(dir, 'chunk-two'))).toBe(false);
  });

  it('undoes an accept on Shift+Tab', async () => {
    writeHistory(entry('echo undo-me', 1_700_000_000_000), entry('echo undo-me', 1_700_000_000_001));
    await startRealDaemon();
    await runPty(`
      pty_start || exit 1
      type_keys 'echo '
      type_keys $'\\t'
      press_probe
      type_keys $'\\e[Z'
      press_probe
      zpty -d tc
    `);
    const [afterTab, afterUndo] = probe();
    expect(afterTab).toBe('buf=[echo undo-me] cur=12 post=[] off=0');
    expect(afterUndo).toBe('buf=[echo ] cur=5 post=[undo-me] off=0');
  });

  it('hands Tab back to zsh completion when nothing is learned', async () => {
    // Empty history: Tab must complete the filename like plain zsh instead of
    // swallowing the key.
    writeFileSync(join(dir, 'zzz-unique-marker.txt'), '');
    await startRealDaemon();
    await runPty(`
      pty_start || exit 1
      type_keys 'ls zzz-uni'
      type_keys $'\\t' 0.8
      press_probe
      zpty -d tc
    `);
    // zsh's own completion adds the trailing space, which is the point: this is
    // its behaviour, not ours.
    expect(probe()[0]).toBe('buf=[ls zzz-unique-marker.txt ] cur=25 post=[] off=0');
  });

  it('expands a magic name on Enter', async () => {
    await startRealDaemon();
    // The handle is created through the daemon API; the pty only types 'dep'.
    expect(daemon?.host.namesCreate('dep', 'touch expanded.marker', dir)).toEqual({ created: true });
    await runPty(`
      pty_start || exit 1
      type_keys 'dep'
      press_enter
      wait_for_file ${dir}/expanded.marker
      zpty -d tc
    `);
    expect(existsSync(join(dir, 'expanded.marker'))).toBe(true);
  });

  it('shows the handle badge for a named command', async () => {
    await startRealDaemon();
    expect(daemon?.host.namesCreate('dep', 'echo badge-me', dir)).toEqual({ created: true });
    await runPty(`
      pty_start || exit 1
      type_keys 'echo badge-me'
      press_probe
      zpty -d tc
    `);
    expect(probe()[0]).toContain('post=[ ⚡dep]');
  });

  it('shows the badge while the named command is still being typed', async () => {
    // The DX complaint this fixes: the indicator used to appear only once the
    // whole command was on the line.
    writeHistory(entry('echo badge-early', 1_700_000_000_000), entry('echo badge-early', 1_700_000_000_001));
    await startRealDaemon();
    expect(daemon?.host.namesCreate('bad', 'echo badge-early', dir)).toEqual({ created: true });
    await runPty(`
      pty_start || exit 1
      type_keys 'echo ba'
      press_probe
      zpty -d tc
    `);
    // Ghost and badge together: 'dge-early' completes the line, ⚡bad names it.
    expect(probe()[0]).toBe('buf=[echo ba] cur=7 post=[dge-early ⚡bad] off=0');
  });

  it('shows no ghost when the suggestion would correct what was typed', async () => {
    // POSTDISPLAY can only append. A candidate like 'Documents/' after typing
    // 'doc' would render as 'documents/' — text that differs from what Tab
    // inserts. The badge and Tab still work, the misleading ghost does not show.
    writeHistory(entry('cd Documents/', 1_700_000_000_000), entry('cd Documents/', 1_700_000_000_001));
    await startRealDaemon();
    await runPty(`
      pty_start || exit 1
      type_keys 'cd doc'
      press_probe
      type_keys $'\t'
      press_probe
      zpty -d tc
    `);
    const [typed, afterTab] = probe();
    expect(typed).toBe('buf=[cd doc] cur=6 post=[] off=0');
    // Tab still accepts the corrected spelling.
    expect(afterTab).toBe('buf=[cd Documents/] cur=13 post=[] off=0');
  });

  it('keeps exactly one highlight entry while typing, and none without a ghost', async () => {
    // zle keeps region_highlight across widget calls: appending one entry per
    // keystroke grew the array for the whole line and left stale lengths behind.
    writeHistory(entry('echo highlight-me', 1_700_000_000_000), entry('echo highlight-me', 1_700_000_000_001));
    await startRealDaemon();
    await runPty(`
      pty_start || exit 1
      type_keys 'echo h'
      press_highlight_probe
      type_keys 'i'
      type_keys 'g'
      type_keys 'h'
      press_highlight_probe
      # Cursor away from the end: the ghost goes, its highlight must go with it.
      type_keys $'\\e[D'
      press_highlight_probe
      zpty -d tc
    `);
    const [first, later, cleared] = probe();
    // One entry, never a growing list.
    expect(first).toContain('hl=1');
    // Buffer-relative offsets, NOT `P0 n`: with the P prefix the offsets count
    // from the start of the whole display, so `P0 n` dims the first n characters
    // of what the user typed and leaves the suggestion in normal colour.
    expect(later).toMatch(/^hl=1 items=\(\d+ \d+ fg=8\)$/);
    // Ghost gone -> its highlight gone, and nobody else's entries were touched.
    expect(cleared).toBe('hl=0 items=()');
  });

  it('falls back to underline on a terminal without 256 colours', async () => {
    // zsh silently drops fg=8 on an 8-colour TERM: the ghost would then render
    // exactly like typed text, which is what makes it look like an overlap.
    writeHistory(entry('echo dim-me', 1_700_000_000_000), entry('echo dim-me', 1_700_000_000_001));
    await startRealDaemon();
    await runPty(
      `
      pty_start || exit 1
      type_keys 'echo d'
      press_highlight_probe
      zpty -d tc
    `,
      { term: 'xterm' },
    );
    expect(probe()[0]).toMatch(/^hl=1 items=\(\d+ \d+ underline\)$/);
  });

  it('expands a magic name typed with surrounding whitespace', async () => {
    // \`\${BUFFER##[[:space:]]##}\` strips nothing without extended_glob, so a
    // handle typed with a leading or trailing space never resolved.
    await startRealDaemon();
    expect(daemon?.host.namesCreate('spc', 'touch spaced.marker', dir)).toEqual({ created: true });
    await runPty(`
      pty_start || exit 1
      type_keys '  spc '
      press_enter
      wait_for_file ${dir}/spaced.marker
      zpty -d tc
    `);
    expect(existsSync(join(dir, 'spaced.marker'))).toBe(true);
  });

  it('never accepts a ghost that belongs to an older line', async () => {
    // Esc-. (insert-last-word) is a zsh default and is not one of the widgets we
    // wrap: it changed BUFFER while the old suggestion stayed on screen, and the
    // right arrow then inserted text the user was never shown for this line.
    writeHistory(entry('echo undo-me', 1_700_000_000_000), entry('echo undo-me', 1_700_000_000_001));
    await startRealDaemon();
    await runPty(`
      pty_start || exit 1
      type_keys 'echo u'
      press_probe
      type_keys $'\e.'
      press_probe
      type_keys $'\e[C'
      press_probe
      zpty -d tc
    `);
    const [withGhost, afterInsertWord, afterArrow] = probe();
    expect(withGhost).toBe('buf=[echo u] cur=6 post=[ndo-me] off=0');
    // Stale ghost gone as soon as the buffer changed under us.
    expect(afterInsertWord).toContain('post=[]');
    // And the arrow key did not paste it in.
    expect(afterArrow).not.toContain('ndo-me]');
  });

  it('brings the suggestion back after left then right', async () => {
    writeHistory(entry('echo undo-me', 1_700_000_000_000), entry('echo undo-me', 1_700_000_000_001));
    await startRealDaemon();
    await runPty(`
      pty_start || exit 1
      type_keys 'echo u'
      type_keys $'\\e[D'
      press_probe
      type_keys $'\\e[C'
      press_probe
      zpty -d tc
    `);
    const [midLine, backAtEnd] = probe();
    expect(midLine).toBe('buf=[echo u] cur=5 post=[] off=0');
    expect(backAtEnd).toBe('buf=[echo u] cur=6 post=[ndo-me] off=0');
  });

  it('shows no suggestion inside its own handle prompt', async () => {
    // read-from-minibuffer sets PREDISPLAY; a ghost there offers a shell command
    // as the answer to "which handle?".
    writeHistory(entry('deploy staging alpha', 1_700_000_000_000), entry('deploy staging alpha', 1_700_000_000_001));
    await startRealDaemon();
    await runPty(`
      pty_start || exit 1
      type_keys 'deploy staging alpha'
      press_probe
      type_keys $'\\C-Xl'
      pump 0.4
      type_keys 'de'
      press_probe
      zpty -d tc
    `);
    const [onLine, inPrompt] = probe();
    expect(onLine).toContain('post=[');
    // Inside the minibuffer: no ghost, no badge.
    expect(inPrompt).toContain('post=[]');
  });

  it('learns an executed command through the precmd hook', async () => {
    await startRealDaemon();
    await runPty(
      `
      pty_start || exit 1
      zpty -w tc 'print learn-me-now'
      wait_for_text ${historyFile} 'print learn-me-now'
      zpty -d tc
    `,
      { learn: true },
    );
    const stored = existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : '';
    expect(stored).toContain('print learn-me-now');
  });

  it('does not learn a space-prefixed command when hist_ignore_space is set', async () => {
    await startRealDaemon();
    await runPty(
      `
      pty_start || exit 1
      zpty -w tc 'setopt hist_ignore_space'
      wait_for_text ${historyFile} 'setopt hist_ignore_space'
      zpty -w tc ' print hidden-secret-command'
      # Give the (rejected) learn attempt time to happen, then a marker command
      # whose arrival proves the shell got that far.
      zpty -w tc 'print settled-marker'
      wait_for_text ${historyFile} 'print settled-marker'
      zpty -d tc
    `,
      { learn: true },
    );
    const stored = existsSync(historyFile) ? readFileSync(historyFile, 'utf8') : '';
    expect(stored).not.toContain('hidden-secret-command');
    // The setopt line itself is learned, which proves learning was live.
    expect(stored).toContain('setopt hist_ignore_space');
  });
});
