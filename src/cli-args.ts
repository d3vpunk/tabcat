export type CliCommand =
  | 'repl'
  | 'import'
  | 'simulate'
  | 'stats'
  | 'names'
  | 'daemon'
  | 'plugin'
  | 'help'
  | 'version';
type DataCommand = Exclude<CliCommand, 'help' | 'version'>;

export interface CliArgs {
  command: CliCommand;
  /** Positional words after the command: `daemon status`, `plugin init zsh`. */
  subs: string[];
  history?: string;
  file?: string;
  line?: string;
  cwd?: string;
  socket?: string;
  now?: number;
  minimal?: boolean;
  json?: boolean;
  check?: boolean;
  commandHelp: boolean;
}

const COMMANDS = new Set<CliCommand>(['repl', 'import', 'simulate', 'stats', 'names', 'daemon', 'plugin', 'help']);
const VALUE_OPTIONS = new Set(['history', 'file', 'line', 'cwd', 'now', 'socket']);
const FLAG_OPTIONS = new Set(['minimal', 'json', 'check']);
const ALLOWED_OPTIONS: Record<DataCommand, ReadonlySet<string>> = {
  repl: new Set(['history', 'minimal']),
  import: new Set(['history', 'file']),
  simulate: new Set(['history', 'line', 'cwd', 'now', 'json']),
  stats: new Set(['history']),
  names: new Set(['history']),
  daemon: new Set(['history', 'socket']),
  plugin: new Set(['check']),
};

/** Which positional words each command accepts after its own name. */
const ALLOWED_SUBS: Partial<Record<DataCommand, readonly (readonly string[])[]>> = {
  daemon: [[], ['status'], ['stop']],
  plugin: [['init'], ['init', 'zsh']],
};

export class CliArgumentError extends Error {
  constructor(
    message: string,
    readonly command?: CliCommand,
  ) {
    super(message);
  }
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let command: CliCommand | undefined;
  let commandHelp = false;
  let version = false;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const subs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === '-h' || token === '--help') {
      commandHelp = true;
      continue;
    }
    if (token === '-v' || token === '--version') {
      version = true;
      continue;
    }
    if (!token.startsWith('-')) {
      if (command === undefined) {
        if (!COMMANDS.has(token as CliCommand)) throw new CliArgumentError(`Unknown command: ${token}`);
        command = token as CliCommand;
      } else {
        // Positional words after the command (`daemon stop`) — validated below,
        // once we know which command they belong to.
        subs.push(token);
      }
      continue;
    }

    const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
    const name = match?.[1];
    if (name && FLAG_OPTIONS.has(name)) {
      if (match?.[2] !== undefined) throw new CliArgumentError(`--${name} does not take a value`, command);
      if (flags.has(name)) throw new CliArgumentError(`Option specified multiple times: --${name}`, command);
      flags.add(name);
      continue;
    }
    if (!name || !VALUE_OPTIONS.has(name)) throw new CliArgumentError(`Unknown option: ${token}`, command);
    if (values.has(name)) throw new CliArgumentError(`Option specified multiple times: --${name}`, command);
    const inline = match?.[2];
    const value = inline ?? argv[++i];
    if (value === undefined || value === '' || (inline === undefined && value.startsWith('-'))) {
      throw new CliArgumentError(`Missing value for --${name}`, command);
    }
    values.set(name, value);
  }

  if (version) {
    if (command !== undefined || commandHelp || values.size > 0 || flags.size > 0 || subs.length > 0) {
      throw new CliArgumentError('--version cannot be combined with other arguments', command);
    }
    return { command: 'version', subs: [], commandHelp: false };
  }

  const resolvedCommand = command ?? (commandHelp ? 'help' : 'repl');
  if (resolvedCommand === 'help') {
    if (values.size > 0 || flags.size > 0) throw new CliArgumentError('help does not accept options', resolvedCommand);
    return { command: 'help', subs: [], commandHelp: false };
  }
  if (resolvedCommand === 'version') throw new CliArgumentError('version is not a command', resolvedCommand);

  const allowedSubs = ALLOWED_SUBS[resolvedCommand];
  if (allowedSubs === undefined) {
    const stray = subs[0];
    if (stray !== undefined) throw new CliArgumentError(`Unexpected argument: ${stray}`, resolvedCommand);
  } else if (!allowedSubs.some((allowed) => allowed.length === subs.length && allowed.every((word, i) => word === subs[i]))) {
    throw new CliArgumentError(
      subs.length === 0 ? `${resolvedCommand} needs a subcommand` : `Unexpected argument: ${subs.join(' ')}`,
      resolvedCommand,
    );
  }

  for (const name of [...values.keys(), ...flags]) {
    if (!ALLOWED_OPTIONS[resolvedCommand].has(name)) {
      throw new CliArgumentError(`--${name} is not valid for ${resolvedCommand}`, resolvedCommand);
    }
  }

  const nowValue = values.get('now');
  const now = nowValue === undefined ? undefined : Number(nowValue);
  if (now !== undefined && !Number.isFinite(now)) {
    throw new CliArgumentError(`Invalid value for --now: ${nowValue}`, resolvedCommand);
  }

  const result: CliArgs = {
    command: resolvedCommand,
    subs,
    commandHelp,
  };
  const history = values.get('history');
  const file = values.get('file');
  const line = values.get('line');
  const cwd = values.get('cwd');
  if (history !== undefined) result.history = history;
  if (file !== undefined) result.file = file;
  if (line !== undefined) result.line = line;
  if (cwd !== undefined) result.cwd = cwd;
  const socket = values.get('socket');
  if (socket !== undefined) result.socket = socket;
  if (now !== undefined) result.now = now;
  if (flags.has('minimal')) result.minimal = true;
  if (flags.has('json')) result.json = true;
  if (flags.has('check')) result.check = true;
  return result;
}

export function commandUsage(command: CliCommand): string {
  switch (command) {
    case 'repl':
      return 'Usage: tabcat [repl] [--history <path>] [--minimal]';
    case 'import':
      return 'Usage: tabcat import [--file <path>] [--history <path>]';
    case 'simulate':
      return 'Usage: tabcat simulate [--line <text>] [--cwd <dir>] [--now <ms>] [--history <path>] [--json]';
    case 'stats':
      return 'Usage: tabcat stats [--history <path>]';
    case 'names':
      return 'Usage: tabcat names [--history <path>]';
    case 'daemon':
      return 'Usage: tabcat daemon [status|stop] [--history <path>] [--socket <path>]';
    case 'plugin':
      return 'Usage: tabcat plugin init zsh [--check]';
    case 'help':
      return 'Usage: tabcat help';
    case 'version':
      return 'Usage: tabcat --version';
  }
}
