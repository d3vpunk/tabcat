import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdin } from 'ink';
import { Predictor, RankedCandidate } from '../engine/predictor.js';
import { CompletionTelemetry } from '../engine/model.js';
import { fuzzySearch } from './history-search.js';
import { nextBoundary } from './text-nav.js';
import { HandlerContext, KeyEvent, KeyOutcome, PromptState, handleKey, initialPromptState } from './prompt-state.js';
import { ReplStats } from './stats.js';

const DROPDOWN_ROWS = 5;

export type PromptResult = { type: 'submit'; line: string; completion: CompletionTelemetry } | { type: 'exit' };

export interface PromptOptions {
  predictor: Predictor;
  cwd: string;
  homeDir: string;
  /** Chronological, oldest first — for up-history and Ctrl-R. */
  historyLines: readonly string[];
  /** Exit code of the last command (undefined = session start). 0 = cyan, ≠0 = red. */
  lastExitCode?: number | undefined;
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
  if (!/^:\w*$/.test(line)) return null;
  return MAGIC_COMMANDS.filter(({ command }) => command.startsWith(line));
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

const HELP_KEYS = [
  ['Tab', 'Accept suggestion / cycle'],
  ['Shift-Tab', 'Undo last accept'],
  ['→', 'Accept next chunk'],
  ['↑ / ↓', 'Navigate history or suggestions'],
  ['Ctrl-R', 'Search history'],
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
  | { kind: 'stats'; stats: ReplStats; historyFile: string }
  | { kind: 'version'; version: string }
  | { kind: 'cwd'; cwd: string };

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
  }
}

function MagicPanel({ title, subtitle, children }: React.PropsWithChildren<{ title: string; subtitle?: string }>) {
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

function PromptApp({ predictor, cwd, homeDir, historyLines, lastExitCode, onDone }: AppProps) {
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

  const { line, cursor, selected, dropdownVisible, historyIndex, historyFilter, searchQuery, searchSelected } = state;

  const prediction = useMemo(
    () => predictor.predict({ line, cursor, cwd }),
    [predictor, line, cursor, cwd],
  );
  // Magic lines (":...") get their candidates from the fixed
  // command list — the predictor does not know them, they never
  // end up in the history.
  const candidates = magicCandidates(line, cursor) ?? prediction.candidates;
  const selectedIndex = Math.min(selected, Math.max(0, candidates.length - 1));
  // Center-anchored: selected stays centered in the window, except at the start/end.
  // This way the window scrolls along smoothly instead of jumping only when selected
  // reaches the bottom edge — and ↑/↓ indicators appear fluidly.
  const dropdownStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(DROPDOWN_ROWS / 2)),
    Math.max(0, candidates.length - DROPDOWN_ROWS),
  );
  const visibleCandidates = candidates.slice(dropdownStart, dropdownStart + DROPDOWN_ROWS);

  // Dedup + reversal ONCE per prompt (not per keystroke): with a
  // large history this would otherwise cost a full O(n) pass in every
  // navigation/search keystroke.
  const recentUnique = useMemo(() => [...new Set([...historyLines].reverse())], [historyLines]);
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
      const collapsed = paste.replace(/[\r\n]+/g, ' ').trim();
      if (collapsed.length > 0) {
        const outcome = handleKey(state, { input: collapsed, key: {} }, {
          candidates,
          prefix: prediction.prefix,
          recentUnique: effectiveHistory,
          searchResults,
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
    };
    const event = { input, key };
    const outcome = handleKey(state, event, ctx);
    completion.current = trackCompletion(completion.current, state, event, outcome, candidates, selectedIndex);
    if (outcome.kind === 'submit') {
      return finish({
        type: 'submit',
        line: outcome.line,
        completion: { ...completion.current, durationMs: Date.now() - startedAt.current },
      });
    }
    if (outcome.kind === 'exit') return finish({ type: 'exit' });
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
  const ghost =
    !finished && magicHints === null && dropdownVisible && cursor === line.length
      ? (candidates[selectedIndex]?.insert ?? '')
      : '';
  const visibleGhost = ghost.slice(0, Math.max(0, win.ghostRemain));

  if (finished) {
    return (
      <Box>
        <Text color={promptColor}>{promptLabel} ❯ </Text>
        <Text>{line.length > lineAvail ? `${line.slice(0, lineAvail - 1)}…` : line}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={promptColor}>{promptLabel} ❯ </Text>
        <Text>{win.before}</Text>
        <Text inverse>{win.at || (visibleGhost ? visibleGhost.slice(0, nextBoundary(visibleGhost, 0)) : ' ')}</Text>
        <Text>{win.after}</Text>
        <Text dimColor>{cursor === line.length ? visibleGhost.slice(nextBoundary(visibleGhost, 0)) : ''}</Text>
      </Box>

      {searchQuery !== null ? (
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
              const { matched, rest } = splitMatched(
                candidate.display,
                candidate.acceptedPrefixLength ?? prediction.prefix.length,
              );
              return (
                <Text key={candidate.display + candidateIndex} {...(isSelected ? { color: 'cyan' } : {})}>
                  {isSelected ? '› ' : '  '}
                  {matched && <Text dimColor>{matched}</Text>}
                  {rest}
                  <Text dimColor> {sourceMarker(candidate.source)}</Text>
                </Text>
              );
            })}
            {candidates.length > DROPDOWN_ROWS && (
              <Text dimColor>{selectedIndex + 1}/{candidates.length}</Text>
            )}
          </Box>
        )
      )}

      <Text dimColor>
        {searchQuery !== null
          ? '🐱 ↑/↓: select · enter: accept · esc: back'
          : dropdownVisible && magicHints === null && selectedIndex > 0 && candidates.length > 0
            ? '🐱 enter/tab: accept · ↑/↓: select · →: chunk · esc: close'
            : '🐱 tab: all · →: chunk · ⇧tab: undo · ^⌫: delete chunk · alt/option+⌫: fast · ^r: search'}
      </Text>
    </Box>
  );
}

const sourceMarker = (source: RankedCandidate['source']): string =>
  source === 'fs' ? '·fs' : source === 'both' ? '·✓' : '';

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
