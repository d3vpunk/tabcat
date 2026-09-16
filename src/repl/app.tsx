import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdin } from 'ink';
import { Predictor, RankedCandidate, acceptedLine } from '../engine/predictor.js';
import { CompletionTelemetry } from '../engine/model.js';
import { HandleIssue, NameIndex, NameScope, handleIssue } from '../engine/names.js';
import { fuzzySearch } from './history-search.js';
import { nextBoundary } from './text-nav.js';
import { HandlerContext, KeyEvent, KeyOutcome, NamingState, PromptState, enterPasteMode, handleKey, initialPromptState } from './prompt-state.js';
import { SETTINGS, specFor } from '../settings/schema.js';
import { ReplStats } from './stats.js';

const DROPDOWN_ROWS = 5;
/** Paste-mode preview cap — enough for a typical multiline curl, no flooding. */
const PASTE_ROWS = 10;

export type PromptResult =
  | {
      type: 'submit';
      line: string;
      completion: CompletionTelemetry;
      /** Only set when the naming badge committed: handle = save, '' = delete-if-named. */
      saveName?: NamingState;
    }
  | { type: 'exit' };

export interface PromptOptions {
  predictor: Predictor;
  cwd: string;
  homeDir: string;
  /** Chronological, oldest first — for up-history and Ctrl-R. */
  historyLines: readonly string[];
  /** Exit code of the last command (undefined = session start). 0 = cyan, ≠0 = red. */
  lastExitCode?: number | undefined;
  /** Magic-name index; absent = feature dormant (no badge, no resolution). */
  names?: NameIndex | undefined;
  /**
   * ^X on a surfaced magic name: persist the deletion (tombstone + index
   * removal). Called while the prompt stays open — the candidate list
   * refreshes in place. Returns false when the write was refused (busy
   * names file), so the toast does not claim a deletion that did not happen.
   */
  onForget?: ((line: string) => boolean) | undefined;
  /** ^S: persist a handle without executing. Returns the toast to show. */
  onName?: ((line: string, save: NamingState) => string) | undefined;
  /**
   * ^X on a history suggestion: remove `line` from the history and rebuild
   * the model. Returns how many entries went — 0 = was not there, negative =
   * the write failed — so the toast can say what actually happened.
   */
  onForgetHistory?: ((line: string) => number) | undefined;
  /**
   * Compact variant for short terminals (IDE panes): the dropdown collapses
   * to a single row with an inline counter and the legend line disappears.
   * Search, paste mode, naming badge and `:`-hints render as in full mode.
   */
  minimal?: boolean | undefined;
  /** Dropdown height in rows (`repl.dropdownRows`). Minimal mode stays at 1. */
  dropdownRows?: number | undefined;
  /**
   * false (`repl.footer`): the key-hint legend disappears like in minimal
   * mode — paste/search hints stay, they ARE the mode UI, not key help.
   */
  footer?: boolean | undefined;
}

type CompletionCounters = Omit<CompletionTelemetry, 'durationMs'>;

export function trackCompletion(
  current: CompletionCounters,
  state: PromptState,
  event: KeyEvent,
  outcome: KeyOutcome,
  candidates: readonly RankedCandidate[],
  selectedIndex: number,
): CompletionCounters {
  const { key } = event;
  const attempted = Boolean(
    (key.tab && !key.shift) ||
    (key.rightArrow && state.cursor === state.line.length && candidates[selectedIndex]?.insert) ||
    (key.return && state.dropdownVisible && selectedIndex > 0 && candidates[selectedIndex]?.insert),
  );
  const accepted = attempted && outcome.kind === 'update' && outcome.state.line !== state.line;
  const undone = Boolean(key.tab && key.shift && outcome.kind === 'update' && outcome.state.line !== state.line);
  return {
    attempts: current.attempts + Number(attempted),
    accepts: current.accepts + Number(accepted),
    top1Accepts: current.top1Accepts + Number(accepted && selectedIndex === 0),
    acceptedChars: current.acceptedChars + (accepted ? Math.max(0, outcome.state.line.length - state.line.length) : 0),
    undos: current.undos + Number(undone),
  };
}

const HELP_COMMANDS = [
  [':help', 'This help'],
  [':history', 'Last 10 commands'],
  [':names', 'Learned magic names'],
  [':settings', 'Show and change settings'],
  [':stats', 'History overview'],
  [':version', 'tabcat version'],
  [':cwd', 'Working directory'],
  [':clear', 'Clear screen'],
  [':meow', 'Summon cat'],
  [':exit', 'Quit tabcat'],
] as const;

const MAGIC_COMMANDS = HELP_COMMANDS.map(([label, description]) => ({
  command: label.split(',')[0] as string,
  description,
}));

export function magicCommandHints(line: string): readonly { command: string; description: string }[] | null {
  if (/^:\w*$/.test(line)) return MAGIC_COMMANDS.filter(({ command }) => command.startsWith(line));
  // `:settings` completes its arguments too: keys, then values (bool/enum).
  // Rendered from the schema — a new setting shows up here by itself.
  if (/^:settings\s/.test(line)) return settingsHints(line);
  return null;
}

function settingsHints(line: string): readonly { command: string; description: string }[] {
  const tokens = line.split(/\s+/).filter((token) => token !== '').slice(1);
  const current = /\s$/.test(line) ? '' : (tokens.pop() ?? '');
  // Completing the CURRENT token in place preserves the user's exact spacing —
  // `command` must extend the typed line for magicCandidates' insert slice.
  const suggest = (words: readonly { word: string; description: string }[]) =>
    words
      .filter(({ word }) => word.startsWith(current) && word !== current)
      .map(({ word, description }) => ({ command: line.slice(0, line.length - current.length) + word, description }));
  const keys = SETTINGS.map((spec) => ({ word: spec.key, description: spec.description }));

  if (tokens.length === 0) return suggest([...keys, { word: 'reset', description: 'Reset a setting to its default' }]);
  if (tokens.length === 1 && tokens[0] === 'reset') return suggest(keys);
  if (tokens.length === 1) {
    const spec = specFor(tokens[0] as string);
    if (spec === undefined) return [];
    if (spec.type === 'bool') {
      return suggest([
        { word: 'true', description: spec.label },
        { word: 'false', description: spec.label },
      ]);
    }
    if (spec.type === 'enum') return suggest(spec.options.map((option) => ({ word: option, description: spec.label })));
  }
  return [];
}

/**
 * Magic commands as real completion candidates from the fixed list:
 * tab-accept, chunk-accept (→), ↑/↓ selection and Shift-Tab undo run
 * unchanged through the normal machinery in prompt-state.ts.
 */
export function magicCandidates(line: string, cursor: number): readonly RankedCandidate[] | null {
  const hints = magicCommandHints(line);
  if (hints === null) return null;
  return hints.map(({ command }) => ({
    display: command,
    insert: command.slice(line.length),
    score: 0,
    source: 'history' as const,
    acceptedPrefixLength: cursor,
    replacePrefixLength: cursor,
  }));
}

/**
 * Live badge validation: red only for a real conflict ON THE LEVEL being
 * named on — a handle taken in another directory is no conflict, and a
 * global one may be shadowed locally. "Too short" stays quiet while typing
 * and only skips the save.
 */
export function namingIssueFor(
  naming: NamingState,
  line: string,
  cwd: string,
  names: NameIndex | undefined,
): HandleIssue | null {
  if (naming.handle === '' || names === undefined) return null;
  // Renaming a command to the handle it already owns is not a collision —
  // exempted by line, so another command's identical handle still blocks.
  return handleIssue(naming.handle, line, names.blockingHandles(naming.scope, cwd, line.trim()));
}

/** Marker and hint line of the naming badge — the badge itself stays dumb. */
export function namingBadge(
  naming: NamingState,
  issue: HandleIssue | null,
): { marker: string; hint: string } {
  const level = naming.scope === 'global' ? 'GLOBAL · ^G: here only' : 'here · ^G: global';
  const reason = issue === 'taken' ? ' · taken' : issue === 'command' ? ' · = command name' : '';
  return {
    marker: naming.scope === 'global' ? '🌐' : '⚡',
    // `a-z 0-9` is the one part that explains the silent input filter:
    // anything else the user types is discarded without a sound.
    hint: `  ${level} · a-z 0-9 · ^S: save · enter: save+run · esc: cancel${reason}`,
  };
}

const HELP_KEYS = [
  ['Tab', 'Accept suggestion / cycle'],
  ['Shift-Tab', 'Undo last accept'],
  ['→', 'Accept next chunk'],
  ['↑ / ↓', 'Navigate history or suggestions'],
  ['Ctrl-R', 'Search history'],
  ['Ctrl-N', 'Name this command'],
  ['Ctrl-G', 'In the naming badge: here only / everywhere'],
  ['Ctrl-S', 'In the naming badge: save without running'],
  ['Ctrl-X', 'Forget selected suggestion / magic name'],
  ['Esc', 'Close suggestions'],
  ['Ctrl-C', 'Clear current input'],
  ['Ctrl-D', 'Quit tabcat'],
] as const;

export function ReplHelp() {
  return (
    <MagicPanel title="help">
      <Text bold>Commands</Text>
      {HELP_COMMANDS.map(([key, description]) => <HelpRow key={key} label={key} description={description} />)}
      <Text> </Text>
      <Text bold>Keys</Text>
      {HELP_KEYS.map(([key, description]) => <HelpRow key={key} label={key} description={description} />)}
      <Text> </Text>
      <Text dimColor>Magic commands are not executed and not learned.</Text>
    </MagicPanel>
  );
}

function HelpRow({ label, description }: { label: string; description: string }) {
  return (
    <Box>
      <Box width={16}><Text color="cyan">{label}</Text></Box>
      <Text dimColor>{description}</Text>
    </Box>
  );
}

export function showReplHelp(): void {
  showPanel(<ReplHelp />);
}

export type ReplOutput =
  | { kind: 'history'; entries: readonly { number: number; line: string }[] }
  | { kind: 'names'; names: readonly { name: string; line: string; active: boolean; scope: NameScope }[] }
  | { kind: 'stats'; stats: ReplStats; historyFile: string }
  | { kind: 'version'; version: string }
  | { kind: 'cwd'; cwd: string }
  | {
      kind: 'settings';
      rows: readonly { key: string; value: string; isDefault: boolean; live: boolean; description: string }[];
    }
  /** Short confirmation or error from a `:` command — one panel, a few lines. */
  | { kind: 'note'; title: string; lines: readonly string[]; error?: boolean };

export function ReplOutputPanel({ output }: { output: ReplOutput }) {
  const contentWidth = Math.max(32, (process.stdout.columns ?? 80) - 7);
  switch (output.kind) {
    case 'history':
      return (
        <MagicPanel title="history" subtitle="last 10">
          {output.entries.length === 0 ? <Text dimColor>No entries</Text> : output.entries.map((entry) => (
            <Box key={entry.number}>
              <Box width={6} justifyContent="flex-end"><Text dimColor>{entry.number}</Text></Box>
              <Text dimColor>  │  </Text>
              <Text>{truncateEnd(singleLine(entry.line), contentWidth - 11)}</Text>
            </Box>
          ))}
        </MagicPanel>
      );
    case 'names': {
      const nameWidth = Math.min(18, Math.max(6, ...output.names.map((n) => n.name.length)) + 2);
      return (
        <MagicPanel title="names" {...(output.names.length > 0 ? { subtitle: `${output.names.length} learned` } : {})}>
          {output.names.length === 0 ? (
            <Text dimColor>No magic names yet — Ctrl-N on a typed command creates one.</Text>
          ) : (
            output.names.map((entry) => (
              <Box key={`${entry.name}${entry.line}`}>
                <Box width={2}>
                  <Text dimColor={!entry.active}>{entry.scope === 'global' ? '🌐' : '⚡'}</Text>
                </Box>
                <Box width={nameWidth}>
                  {entry.active ? <Text color="magenta" bold>{entry.name}</Text> : <Text dimColor>{entry.name}</Text>}
                </Box>
                <Text dimColor={!entry.active}>{truncateEnd(singleLine(entry.line), contentWidth - nameWidth - 4)}</Text>
              </Box>
            ))
          )}
          {output.names.some((entry) => !entry.active) && (
            <Text dimColor>dimmed: belong to other directories · 🌐 applies everywhere</Text>
          )}
        </MagicPanel>
      );
    }
    case 'stats':
      return (
        <MagicPanel title="stats" subtitle={periodLabel(output.stats)}>
          <Metric label="Commands" value={formatNumber(output.stats.entries)} />
          <Metric label="Today" value={formatNumber(output.stats.today)} />
          <Metric label="Success rate" value={formatPercent(output.stats.successRate)} />
          <Metric label="Unique commands" value={formatNumber(output.stats.uniqueCommands)} />
          <Metric label="Directories" value={formatNumber(output.stats.directories)} />
          <Metric label="Active streak" value={`${output.stats.streakDays} ${output.stats.streakDays === 1 ? 'day' : 'days'}`} />
          <Text> </Text>
          <Text bold>Autocomplete</Text>
          <Metric label="Saved chars" value={formatNumber(output.stats.savedChars)} />
          <Metric label="Accept rate" value={formatPercent(output.stats.acceptRate)} />
          <Metric label="Top-1 hit rate" value={formatPercent(output.stats.top1Rate)} />
          <Metric label="Ø Completion" value={output.stats.averageAcceptedChars === null ? '–' : `${output.stats.averageAcceptedChars.toFixed(1)} chars`} />
          <Metric label="Undo rate" value={formatPercent(output.stats.undoRate)} />
          <Metric label="Ø to Enter" value={formatDuration(output.stats.averageDurationMs)} />
          {output.stats.telemetryEntries === 0 && <Text dimColor>No completion telemetry recorded yet.</Text>}
          <RankedList title="Top Commands" values={output.stats.topCommands} width={contentWidth} />
          <RankedList title="Top Directories" values={output.stats.topDirectories} width={contentWidth} paths />
          <Text> </Text>
          <Text dimColor>History</Text>
          <Text color="cyan">{truncateMiddle(singleLine(output.historyFile), contentWidth)}</Text>
        </MagicPanel>
      );
    case 'version':
      return <MagicPanel title="version"><Text color="cyan" bold>v{output.version}</Text></MagicPanel>;
    case 'cwd':
      return <MagicPanel title="cwd"><Text color="cyan">{truncateMiddle(singleLine(output.cwd), contentWidth)}</Text></MagicPanel>;
    case 'settings': {
      const keyWidth = Math.max(...output.rows.map((row) => row.key.length)) + 2;
      const valueWidth = Math.max(7, ...output.rows.map((row) => row.value.length)) + 2;
      return (
        <MagicPanel title="settings">
          {output.rows.map((row) => (
            <Box key={row.key}>
              <Box width={keyWidth}><Text color="cyan">{row.key}</Text></Box>
              <Box width={valueWidth}>
                {row.isDefault ? <Text dimColor>{row.value}</Text> : <Text color="magenta" bold>{row.value}</Text>}
              </Box>
              <Text dimColor>{truncateEnd(row.description + (row.live ? '' : ' (next start)'), contentWidth - keyWidth - valueWidth)}</Text>
            </Box>
          ))}
          {output.rows.some((row) => !row.isDefault) && <Text dimColor>highlighted: changed from the default</Text>}
          <Text> </Text>
          <Text dimColor>:settings {'<key>'} {'<value>'} sets · :settings reset {'<key>'} restores the default</Text>
        </MagicPanel>
      );
    }
    case 'note':
      return (
        <MagicPanel title={output.title}>
          {output.lines.map((line) => (
            <Text key={line} {...(output.error === true ? { color: 'red' } : {})}>{truncateEnd(singleLine(line), contentWidth)}</Text>
          ))}
        </MagicPanel>
      );
  }
}

export function MagicPanel({ title, subtitle, children }: React.PropsWithChildren<{ title: string; subtitle?: string }>) {
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Box
        flexDirection="column"
        marginLeft={2}
        paddingLeft={1}
        borderStyle="single"
        borderColor="gray"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
      >
        <Box>
          <Text bold color="cyan">🐱 tabcat :{title}</Text>
          {subtitle && <Text dimColor>  {subtitle}</Text>}
        </Box>
        <Text dimColor>─</Text>
        {children}
      </Box>
      <Text> </Text>
    </Box>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={21}><Text dimColor>{label}</Text></Box>
      <Text bold color="cyan">{value}</Text>
    </Box>
  );
}

function RankedList({
  title,
  values,
  width,
  paths = false,
}: {
  title: string;
  values: ReplStats['topCommands'];
  width: number;
  paths?: boolean;
}) {
  if (values.length === 0) return null;
  const countWidth = Math.max(5, ...values.map((item) => formatNumber(item.count).length));
  const valueWidth = Math.max(12, width - 4 - countWidth - 2);
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text bold>{title}</Text>
      {values.map((item, index) => (
        <Box key={item.value}>
          <Box width={4}><Text dimColor>{index + 1}.</Text></Box>
          <Box width={valueWidth}>
            <Text>{paths ? truncateMiddle(singleLine(item.value), valueWidth - 2) : truncateEnd(singleLine(item.value), valueWidth - 2)}</Text>
          </Box>
          <Box width={countWidth} justifyContent="flex-end"><Text bold color="cyan">{formatNumber(item.count)}</Text></Box>
        </Box>
      ))}
    </Box>
  );
}

const formatNumber = (value: number): string => new Intl.NumberFormat('en-US').format(value);
const formatPercent = (value: number | null): string => value === null ? '–' : `${Math.round(value * 100)}%`;
const formatDuration = (value: number | null): string => value === null ? '–' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
const formatDate = (timestamp: number): string => new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(timestamp);
const periodLabel = (stats: ReplStats): string => stats.firstTs === null || stats.lastTs === null
  ? 'no data'
  : `${formatDate(stats.firstTs)} – ${formatDate(stats.lastTs)}`;

export const singleLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function truncateEnd(value: string, width: number): string {
  if (value.length <= width) return value;
  return width <= 1 ? '…'.slice(0, width) : `${value.slice(0, width - 1)}…`;
}

export function truncateMiddle(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return '…'.slice(0, width);
  const left = Math.ceil((width - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - (width - 1 - left))}`;
}

export function showReplOutput(output: ReplOutput): void {
  showPanel(<ReplOutputPanel output={output} />);
}

function showPanel(node: React.ReactNode): void {
  const instance = render(node, { patchConsole: false });
  instance.unmount();
}

/**
 * Renders exactly one smart prompt and returns the confirmed line.
 * After Enter the typed line stays as a normal terminal line
 * (last Ink frame without dropdown) — no alternate buffer, no screen switch.
 */
export async function promptOnce(options: PromptOptions): Promise<PromptResult> {
  let result: PromptResult = { type: 'exit' };
  const instance = render(<PromptApp {...options} onDone={(r) => (result = r)} />, {
    exitOnCtrlC: false,
  });
  await instance.waitUntilExit();
  return result;
}

interface AppProps extends PromptOptions {
  onDone: (result: PromptResult) => void;
}

function PromptApp({ predictor, cwd, homeDir, historyLines, lastExitCode, names, onForget, onName, onForgetHistory, minimal = false, dropdownRows: dropdownRowsSetting = DROPDOWN_ROWS, footer = true, onDone }: AppProps) {
  const { exit } = useApp();
  const { internal_eventEmitter } = useStdin();

  // All UX rules (accept, undo, history stash, Ctrl-R) live in the pure
  // handleKey (prompt-state.ts) — here we only hold state + render.
  const [state, setState] = useState<PromptState>(initialPromptState);
  const [finished, setFinished] = useState(false);
  const startedAt = useRef(Date.now());
  const completion = useRef<CompletionCounters>({
    attempts: 0,
    accepts: 0,
    top1Accepts: 0,
    acceptedChars: 0,
    undos: 0,
  });

  const { line, cursor, selected, dropdownVisible, historyFilter, searchQuery, searchSelected, naming, pasted } = state;

  // ^X mutates the NameIndex inside the predictor mid-prompt — the counter
  // invalidates the memo below so the forgotten candidate disappears at once.
  const [namesVersion, setNamesVersion] = useState(0);
  // Same trick for a forgotten history line: run.ts splices `historyLines` and
  // rebuilds the predictor IN PLACE, so every reference the memos key on stays
  // identical — without the counter both would keep serving the deleted line.
  const [historyVersion, setHistoryVersion] = useState(0);
  // Short-lived confirmation under the prompt ("forgot …"). One line, no modal
  // — forgetting was deliberate, the toast only proves it happened.
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 2_500);
    return () => clearTimeout(timer);
  }, [toast]);
  const prediction = useMemo(
    () => predictor.predict({ line, cursor, cwd }),
    [predictor, line, cursor, cwd, namesVersion, historyVersion],
  );
  // Magic lines (":...") get their candidates from the fixed
  // command list — the predictor does not know them, they never
  // end up in the history.
  const candidates = magicCandidates(line, cursor) ?? prediction.candidates;
  const selectedIndex = Math.min(selected, Math.max(0, candidates.length - 1));
  // Minimal variant: exactly one dropdown row — the window degenerates to
  // the selected candidate, the counter moves inline into that row.
  const dropdownRows = minimal ? 1 : dropdownRowsSetting;
  // repl.footer=false borrows minimal's legend rule: key help disappears,
  // paste/search hints stay — they are the mode UI, not key help.
  const legendCompact = minimal || !footer;
  // Center-anchored: selected stays centered in the window, except at the start/end.
  // This way the window scrolls along smoothly instead of jumping only when selected
  // reaches the bottom edge — and ↑/↓ indicators appear fluidly.
  const dropdownStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(dropdownRows / 2)),
    Math.max(0, candidates.length - dropdownRows),
  );
  const visibleCandidates = candidates.slice(dropdownStart, dropdownStart + dropdownRows);

  // Dedup + reversal ONCE per prompt (not per keystroke): with a
  // large history this would otherwise cost a full O(n) pass in every
  // navigation/search keystroke. Multiline entries (verbatim paste-mode
  // submits) are excluded: the single-line editor cannot render or safely
  // re-edit them — re-paste instead of recall.
  const recentUnique = useMemo(
    () => [...new Set([...historyLines].reverse())].filter((entry) => !entry.includes('\n')),
    [historyLines, historyVersion],
  );
  // Substring search (fish-style ↑/↓): filter recentUnique by historyFilter,
  // so navigateSubstring navigates directly through the match list. Outside
  // filter mode effectiveHistory is identical to recentUnique.
  const effectiveHistory = useMemo(
    () => historyFilter !== null ? recentUnique.filter((entry) => entry.includes(historyFilter)) : recentUnique,
    [recentUnique, historyFilter],
  );

  const searchResults = useMemo(
    () => (searchQuery === null ? [] : fuzzySearch(searchQuery, recentUnique)),
    [searchQuery, recentUnique],
  );

  // Enter must feel instant: first paint the frozen frame (prompt +
  // line, without dropdown), THEN unmount — exit() in the same
  // tick would leave the old dropdown frame up until command output arrives.
  const resultRef = useRef<PromptResult | null>(null);
  useEffect(() => {
    if (finished && resultRef.current) {
      onDone(resultRef.current);
      exit();
    }
  }, [finished, onDone, exit]);

  // Bracketed paste mode (DECSET 2004): the terminal sends pasted content
  // as ESC[200~…ESC[201~. Enable at the prompt, disable again on unmount
  // (before the command) — otherwise the child shell inherits the mode.
  const pasteRef = useRef<{ active: boolean; buffer: string }>({ active: false, buffer: '' });
  useEffect(() => {
    process.stdout.write('\x1b[?2004h');
    return () => {
      process.stdout.write('\x1b[?2004l');
    };
  }, []);

  // Home/End: Ink's useInput recognizes the sequences but drops them (no key
  // flag, input === ''), so we tap the raw stdin chunk Ink re-emits on its
  // internal emitter. useInput still fires for the same chunk as a no-op — the
  // reference-equality guard below keeps it from reverting the cursor move.
  useEffect(() => {
    const emitter = internal_eventEmitter;
    if (!emitter) return;
    const onRaw = (chunk: unknown) => {
      const name = homeEndKey(String(chunk));
      if (name === null) return;
      setState((prev) => {
        const outcome = handleKey(prev, { input: '', key: { [name]: true } }, CURSOR_ONLY_CTX);
        return outcome.kind === 'update' ? outcome.state : prev;
      });
    };
    emitter.on('input', onRaw);
    return () => {
      emitter.off('input', onRaw);
    };
  }, [internal_eventEmitter]);

  const finish = (r: PromptResult) => {
    resultRef.current = r;
    setFinished(true);
  };

  useInput((input, key) => {
    if (finished) return;

    // Bracketed paste: insert multi-line paste as a single line (newlines →
    // space). Prevents Enter from firing per line and accidentally submitting
    // the first line. Runs through the normal typing input in handleKey,
    // so undo anchoring and withLine insert are reused.
    const paste = extractPaste(input, pasteRef);
    if (paste !== null) {
      // Multiline pastes bypass the completion machinery entirely: the block
      // is shown verbatim below the prompt, Enter runs it exactly as pasted
      // (continuations, quoting and one-command-per-line stay intact — any
      // collapse to a single line would corrupt `\`-continued commands into
      // escaped spaces). Single-line pastes keep the normal inline insert.
      if (isMultilinePaste(paste)) {
        setState((prev) => enterPasteMode(prev, paste));
        return;
      }
      const collapsed = sanitizeInsert(paste).trim();
      if (collapsed.length > 0) {
        const outcome = handleKey(state, { input: collapsed, key: {} }, {
          candidates,
          prefix: prediction.prefix,
          recentUnique: effectiveHistory,
          searchResults,
          cwd,
          ...(names ? { names } : {}),
        });
        if (outcome.kind === 'update') setState(outcome.state);
      }
      return;
    }
    if (pasteRef.current.active) return; // paste in progress, wait for final chunk

    const ctx: HandlerContext = {
      candidates,
      prefix: prediction.prefix,
      recentUnique: effectiveHistory,
      searchResults,
      cwd,
      ...(names ? { names } : {}),
    };
    // A multi-character chunk without paste markers is never keystrokes — it
    // is type-ahead that queued up in the tty before this prompt read it
    // (iTerm "Send text at start", tmux send-keys, typing during command
    // output). Sanitize it like a paste so raw newlines and control bytes
    // never reach the editor line; real keys always arrive as single
    // characters or as flags on `key`.
    const event = input.length > 1 && !key.ctrl && !key.meta ? { input: sanitizeInsert(input), key } : { input, key };
    const outcome = handleKey(state, event, ctx);
    completion.current = trackCompletion(completion.current, state, event, outcome, candidates, selectedIndex);
    if (outcome.kind === 'submit') {
      return finish({
        type: 'submit',
        line: outcome.line,
        completion: { ...completion.current, durationMs: Date.now() - startedAt.current },
        ...(outcome.saveName !== undefined ? { saveName: outcome.saveName } : {}),
      });
    }
    if (outcome.kind === 'exit') return finish({ type: 'exit' });
    if (outcome.kind === 'forget') {
      // Delete the surfaced magic name, keep the prompt open: persistence
      // happens outside (tombstone + index removal), the bumped version
      // recomputes the prediction without the forgotten handle.
      const forgotten = onForget?.(outcome.line);
      setNamesVersion((version) => version + 1);
      setToast(forgotten === false ? 'names file is busy — nothing forgotten' : `forgot ⚡${outcome.line}`);
      return setState(outcome.state);
    }
    if (outcome.kind === 'name') {
      // Saved without executing: the prompt stays open, the bumped version
      // recomputes the prediction with the new handle in play.
      const toastText = onName?.(outcome.line, outcome.saveName) ?? 'could not save the handle';
      setNamesVersion((version) => version + 1);
      setToast(toastText);
      return setState(outcome.state);
    }
    if (outcome.kind === 'forget-history') {
      // Remove the line from the history, keep the prompt open. The counter
      // recomputes prediction and recentUnique — run.ts mutated both sources
      // in place, so no reference the memos key on has changed.
      const removed = onForgetHistory?.(outcome.line) ?? 0;
      if (removed > 0) {
        setHistoryVersion((version) => version + 1);
        const label = truncateEnd(singleLine(outcome.line), 48);
        setToast(`forgot "${label}"${removed > 1 ? ` (${removed}×)` : ''}`);
      } else {
        setToast(removed < 0 ? 'could not forget — history file is busy' : 'not in history — nothing forgotten');
      }
      return setState(outcome.state);
    }
    if (outcome.kind === 'clear') {
      // ^L: clear the visible screen (scrollback stays), Ink re-renders.
      process.stdout.write('\x1B[2J\x1B[H');
      return setState(outcome.state);
    }
    // Unhandled keys return the same state reference (handleKey's update(state)).
    // Skipping setState there keeps the Home/End raw listener's cursor move from
    // being reverted when useInput fires as a no-op for the same chunk.
    if (outcome.state !== state) setState(outcome.state);
  });

  const promptLabel = shortenCwd(cwd, homeDir);
  const promptColor = lastExitCode === undefined || lastExitCode === 0 ? 'cyan' : 'red';
  const promptWidth = promptLabel.length + 2; // "❯ "
  const lineAvail = Math.max(20, (process.stdout.columns ?? 80) - promptWidth);
  const win = lineWindow(line, cursor, lineAvail);
  const magicHints = magicCommandHints(line);
  // No inline ghost for magic candidates: the handle is not a textual prefix
  // of the command — the dropdown row shows the resolution instead.
  const ghost =
    !finished && naming === null && pasted === null && magicHints === null && dropdownVisible && cursor === line.length &&
    candidates[selectedIndex]?.source !== 'magic'
      ? (candidates[selectedIndex]?.insert ?? '')
      : '';
  const visibleGhost = ghost.slice(0, Math.max(0, win.ghostRemain));

  const namingIssue: HandleIssue | null = naming !== null ? namingIssueFor(naming, line, cwd, names) : null;
  // Hoisted next to namingIssue: the badge branch renders marker and hint,
  // and the fallback only exists because that branch is a ternary arm.
  const badge = naming !== null ? namingBadge(naming, namingIssue) : { marker: '', hint: '' };
  // Discovery badge: the typed line (or the line as it would be if the top
  // suggestion were accepted — computed per dropdown row) already has a handle
  // here. This is the loop: discover via badge → next time type the handle.
  const discoveryHandle = !finished && naming === null && pasted === null && names ? names.handleFor(line.trim(), cwd) : null;

  const pasteLines = pasted !== null ? pasted.split('\n') : [];

  if (finished) {
    // Paste-mode submit: the editor line is empty — freeze a collapsed
    // preview of the block instead so the terminal keeps a scrollback trace.
    const frozen = pasted !== null ? singleLine(pasted) : line;
    return (
      <Box>
        <Text color={promptColor}>{promptLabel} ❯ </Text>
        <Text>{frozen.length > lineAvail ? `${frozen.slice(0, lineAvail - 1)}…` : frozen}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={promptColor}>{promptLabel} ❯ </Text>
        {pasted !== null ? (
          // Anything typed before the paste is merged into the block below —
          // the editor line stays blank until the block runs or is discarded.
          <Text dimColor>(paste)</Text>
        ) : naming !== null ? (
          // Frozen while naming — only the badge below is being edited.
          <Text>{line.length > lineAvail ? `${line.slice(0, lineAvail - 1)}…` : line}</Text>
        ) : (
          <>
            <Text>{win.before}</Text>
            <Text inverse>{win.at || (visibleGhost ? visibleGhost.slice(0, nextBoundary(visibleGhost, 0)) : ' ')}</Text>
            <Text>{win.after}</Text>
            <Text dimColor>{cursor === line.length ? visibleGhost.slice(nextBoundary(visibleGhost, 0)) : ''}</Text>
          </>
        )}
      </Box>

      {pasted !== null ? (
        <Box
          flexDirection="column"
          marginLeft={1}
          paddingLeft={1}
          borderStyle="single"
          borderColor="gray"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
        >
          {pasteLines.slice(0, PASTE_ROWS).map((pasteLine, i) => (
            <Text key={i}>{truncateEnd(pasteLine, Math.max(20, (process.stdout.columns ?? 80) - 6))}</Text>
          ))}
          {pasteLines.length > PASTE_ROWS && (
            <Text dimColor>… +{pasteLines.length - PASTE_ROWS} more lines</Text>
          )}
        </Box>
      ) : naming !== null ? (
        <Box>
          <Text backgroundColor={namingIssue !== null ? 'red' : 'blue'} color="whiteBright" bold>
            {` ${badge.marker} ${naming.handle}▏ `}
          </Text>
          <Text dimColor>{badge.hint}</Text>
        </Box>
      ) : searchQuery !== null ? (
        <Box
          flexDirection="column"
          marginLeft={1}
          paddingLeft={1}
          borderStyle="single"
          borderColor="gray"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
        >
          <Text color="yellow">(ctrl-r) search: {searchQuery}▏</Text>
          {searchResults.map((result, i) => (
            <Text key={result} {...(i === searchSelected ? { color: 'yellow' } : {})}>
              {i === searchSelected ? '› ' : '  '}{result}
            </Text>
          ))}
        </Box>
      ) : magicHints !== null ? (
        <Box flexDirection="column" marginLeft={2}>
          {magicHints.map(({ command, description }) => (
            <Box key={command}>
              <Box width={14}><Text color="cyan" dimColor>{command}</Text></Box>
              <Text dimColor>{description}</Text>
            </Box>
          ))}
        </Box>
      ) : (
        dropdownVisible &&
        candidates.length > 0 && (
          <Box
            flexDirection="column"
            marginLeft={1}
            paddingLeft={1}
            borderStyle="single"
            borderColor="gray"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
          >
            {visibleCandidates.map((candidate, i) => {
              const candidateIndex = dropdownStart + i;
              const isSelected = candidateIndex === selectedIndex;
              // Minimal: the counter has no row of its own — it rides along
              // dim at the end of the single visible row.
              const counterText = minimal && candidates.length > 1
                ? `  ${selectedIndex + 1}/${candidates.length}`
                : '';
              const inlineCounter = counterText !== '' ? <Text dimColor>{counterText}</Text> : null;
              const columns = process.stdout.columns ?? 80;
              if (candidate.source === 'magic') {
                // Handle in magenta, resolved command dim — the row itself IS
                // the resolution preview (no ghost for magic candidates).
                const display = minimal
                  ? clampMinimalDisplay(candidate.display, columns, 2 + 3 + (candidate.magicName?.length ?? 0) + 2 + counterText.length)
                  : candidate.display;
                return (
                  <Text key={candidate.display + candidateIndex} {...(isSelected ? { color: 'cyan' } : {})}>
                    {isSelected ? '› ' : '  '}
                    <Text color="magenta" bold>⚡ {candidate.magicName}</Text>
                    <Text dimColor>  {display}</Text>
                    {inlineCounter}
                  </Text>
                );
              }
              // Discovery: accepting this suggestion would land on a command
              // that already has a handle here — teach it inline.
              const discovered =
                isSelected && names && cursor === line.length
                  ? names.handleFor(acceptedLine(line, cursor, candidate, prediction.prefix.length).trim(), cwd)
                  : null;
              const display = minimal
                ? clampMinimalDisplay(
                    candidate.display,
                    columns,
                    2 + (discovered !== null ? discovered.length + 7 : 0) + 4 + counterText.length,
                  )
                : candidate.display;
              const { matched, rest } = splitMatched(
                display,
                candidate.acceptedPrefixLength ?? prediction.prefix.length,
              );
              return (
                <Text key={candidate.display + candidateIndex} {...(isSelected ? { color: 'cyan' } : {})}>
                  {isSelected ? '› ' : '  '}
                  {discovered !== null && (
                    <Text backgroundColor="blue" color="whiteBright" bold>{` ⚡ ${discovered} `}</Text>
                  )}
                  {discovered !== null && ' '}
                  {matched && <Text dimColor>{matched}</Text>}
                  {rest}
                  <Text dimColor> {sourceMarker(candidate.source)}</Text>
                  {inlineCounter}
                </Text>
              );
            })}
            {!minimal && candidates.length > dropdownRows && (
              <Text dimColor>{selectedIndex + 1}/{candidates.length}</Text>
            )}
          </Box>
        )
      )}

      {/* The toast borrows the legend's line instead of adding one: transient,
          and the legend's key help is the least missed thing for 2.5 seconds. */}
      {naming === null && toast !== null && (
        <Box>
          <Text color="yellow">🐱 {toast}</Text>
        </Box>
      )}
      {naming === null && toast === null && legendVisible(legendCompact, {
        pasted,
        searchQuery,
        discoveryHandle,
        magicHints,
        dropdownOpen: dropdownVisible && candidates.length > 0,
      }) && (
        <Box>
          {discoveryHandle !== null && (
            <Text backgroundColor="blue" color="whiteBright" bold>{` ⚡ ${discoveryHandle} `}</Text>
          )}
          {discoveryHandle !== null && <Text> </Text>}
          {/* Minimal keeps the legend only for paste/search (their hints ARE
              the mode UI) — the discovery badge stands alone without key help. */}
          {(!legendCompact || pasted !== null || searchQuery !== null) && (
            <Text dimColor>
              {pasted !== null
                ? '🐱 multiline paste · enter: run as pasted · esc: discard'
                : searchQuery !== null
                ? '🐱 ↑/↓: select · enter: accept · ^x: forget · esc: back'
                : dropdownVisible && magicHints === null && candidates[selectedIndex]?.source === 'magic'
                  ? '🐱 enter/tab: accept · ^x: forget name · ↑/↓: select · esc: close'
                  : discoveryHandle !== null
                    ? '🐱 enter: run · ^n: rename · ^x: forget name'
                    : dropdownVisible && magicHints === null && selectedIndex > 0 && candidates.length > 0
                      ? '🐱 enter/tab: accept · ↑/↓: select · →: chunk · ^x: forget · esc: close'
                      : '🐱 tab: all · →: chunk · ⇧tab: undo · ^⌫: delete chunk · alt/option+⌫: fast · ^r: search'}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

const sourceMarker = (source: RankedCandidate['source']): string =>
  source === 'fs' ? '·fs' : source === 'both' ? '·✓' : '';

/**
 * Width clamp for the single dropdown row in the minimal variant: badge,
 * marker and inline counter must never push the row into a terminal
 * line-wrap — a wrapped row would silently spend the second (and last)
 * screen line the variant promises not to use. `overheadCols` counts every
 * column in the row besides the display itself; 6 more columns cover the
 * box indent (margin + border + padding) plus a safety margin for
 * double-width glyphs (⚡). Floor of 10 keeps a usable stub on tiny panes.
 */
export function clampMinimalDisplay(display: string, columns: number, overheadCols: number): string {
  return truncateEnd(display, Math.max(10, columns - 6 - overheadCols));
}

/**
 * Bottom line in a compact prompt (minimal variant, or `repl.footer` off):
 * gone in the default state (budget: prompt + max one extra line). It stays
 * for paste/search — their hints are the mode UI — and for the discovery
 * badge, but only when the one-line budget below the prompt is not already
 * spent on the dropdown or `:`-hints.
 */
export function legendVisible(
  compact: boolean,
  state: {
    pasted: string | null;
    searchQuery: string | null;
    discoveryHandle: string | null;
    magicHints: unknown | null;
    dropdownOpen: boolean;
  },
): boolean {
  if (!compact) return true;
  if (state.pasted !== null || state.searchQuery !== null) return true;
  return state.discoveryHandle !== null && state.magicHints === null && !state.dropdownOpen;
}

/**
 * A paste counts as multiline when newlines remain after stripping trailing
 * whitespace — a copied single command usually carries one trailing newline
 * and must keep the inline behavior (a shell would even auto-run it; we
 * never do).
 */
export function isMultilinePaste(paste: string): boolean {
  return /[\r\n]/.test(paste.replace(/\s+$/, ''));
}

/**
 * Shared sanitizing for text that arrives as a block (bracketed paste or a
 * raw type-ahead burst): newlines and tabs collapse to a single space so no
 * line ever submits or renders as extra rows, remaining control characters
 * and U+FFFD (replacement character — the tail of a byte sequence another
 * reader of the tty already consumed half of) are dropped.
 */
export function sanitizeInsert(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\uFFFD]/g, '');
}

/**
 * Bracketed paste detection (DECSET 2004): the terminal sends pasted
 * content as ESC[200~ <content> ESC[201~. Multi-part pastes (large buffers
 * arrive in chunks) are accumulated via the ref state. Returns the
 * finished paste content or null (not complete yet / not a paste).
 * Content outside the markers is not processed — in practice there is
 * nothing before/after a paste (the terminal writes it as its own chunk).
 */
export function extractPaste(
  input: string,
  ref: { current: { active: boolean; buffer: string } },
): string | null {
  if (ref.current.active) {
    const end = findMarker(input, PASTE_END);
    if (end === null) {
      ref.current.buffer += input;
      return null;
    }
    const content = ref.current.buffer + input.slice(0, end.start);
    ref.current.active = false;
    ref.current.buffer = '';
    return content;
  }
  const start = findMarker(input, PASTE_START);
  if (start === null) return null;
  const afterStart = input.slice(start.end);
  const end = findMarker(afterStart, PASTE_END);
  if (end === null) {
    ref.current.active = true;
    ref.current.buffer = afterStart;
    return null;
  }
  return afterStart.slice(0, end.start);
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Locates a bracketed-paste marker, tolerating a missing leading ESC:
 * Ink's useInput strips one leading ESC from every chunk (parse-keypress +
 * use-input.js), so a paste that fills a whole chunk arrives as "[200~…"
 * without its ESC, while markers mid-chunk keep it. Match both forms.
 */
export function findMarker(input: string, marker: string): { start: number; end: number } | null {
  const withEsc = input.indexOf(marker);
  if (withEsc !== -1) return { start: withEsc, end: withEsc + marker.length };
  const bare = marker.slice(1); // marker without its leading ESC
  const bareIdx = input.indexOf(bare);
  if (bareIdx !== -1) return { start: bareIdx, end: bareIdx + bare.length };
  return null;
}

/**
 * Maps a raw Home/End escape sequence (across common terminal encodings) to a
 * key name. Ink's useInput recognizes these but does not expose them on its key
 * object, so app.tsx taps the raw stdin chunk to handle them.
 */
export function homeEndKey(sequence: string): 'home' | 'end' | null {
  switch (sequence) {
    case '\x1b[H':
    case '\x1bOH':
    case '\x1b[1~':
    case '\x1b[7~':
      return 'home';
    case '\x1b[F':
    case '\x1bOF':
    case '\x1b[4~':
    case '\x1b[8~':
      return 'end';
    default:
      return null;
  }
}

/** Home/End carry no completion context — a minimal ctx suffices for handleKey. */
const CURSOR_ONLY_CTX: HandlerContext = { candidates: [], prefix: '', recentUnique: [], searchResults: [] };

/**
 * Splits the typed prefix from the rest of a dropdown candidate for
 * highlighting: the prefix is rendered dim, the completion part
 * normal (or bold when selected). `matchedLen` is clamped to the display
 * length — for fs candidates the escaped prefix can be longer than the
 * typed input.
 */
export function splitMatched(display: string, matchedLen: number): { matched: string; rest: string } {
  const len = Math.min(Math.max(0, matchedLen), display.length);
  return { matched: display.slice(0, len), rest: display.slice(len) };
}

/**
 * Window for very long lines: cursor-centered, with `…` markers when
 * clipped left/right. Prevents uncontrolled wrapping with
 * 500-char pastes — the full line stays in `line` (data), only the
 * rendering is clamped. `…` is 1 terminal column wide.
 */
export function lineWindow(line: string, cursor: number, avail: number): {
  before: string;
  at: string;
  after: string;
  ghostRemain: number;
} {
  if (line.length <= avail) {
    return {
      before: line.slice(0, cursor),
      at: line.slice(cursor, nextBoundary(line, cursor)),
      after: line.slice(nextBoundary(line, cursor)),
      ghostRemain: avail - line.length,
    };
  }
  // Reserve 2 columns for possible `…` markers; cursor-centered.
  const contentAvail = Math.max(10, avail - 2);
  const half = Math.floor(contentAvail / 2);
  let start = Math.max(0, cursor - half);
  let end = Math.min(line.length, start + contentAvail);
  if (end - start < contentAvail) start = Math.max(0, end - contentAvail);
  const leftMark = start > 0 ? '…' : '';
  const rightMark = end < line.length ? '…' : '';
  const before = leftMark + line.slice(start, cursor);
  const cursorEnd = Math.min(nextBoundary(line, cursor), end);
  const at = line.slice(cursor, cursorEnd) || ' ';
  const after = line.slice(cursorEnd, end) + rightMark;
  // Ghost space: only relevant when the cursor is at end of line (otherwise
  // no ghost is shown). Remaining columns in the window after before/at/after.
  const ghostRemain = cursor === line.length ? Math.max(0, avail - before.length - at.length - after.length) : 0;
  return { before, at, after, ghostRemain };
}

export function shortenCwd(cwd: string, home: string): string {
  return cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}
