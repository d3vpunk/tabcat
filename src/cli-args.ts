export type CliCommand = 'repl' | 'import' | 'simulate' | 'stats' | 'names' | 'help' | 'version';
type DataCommand = Exclude<CliCommand, 'help' | 'version'>;

export interface CliArgs {
  command: CliCommand;
  history?: string;
  file?: string;
  line?: string;
  cwd?: string;
  now?: number;
  commandHelp: boolean;
}

const COMMANDS = new Set<CliCommand>(['repl', 'import', 'simulate', 'stats', 'names', 'help']);
const VALUE_OPTIONS = new Set(['history', 'file', 'line', 'cwd', 'now']);
const ALLOWED_OPTIONS: Record<DataCommand, ReadonlySet<string>> = {
  repl: new Set(['history']),
  import: new Set(['history', 'file']),
  simulate: new Set(['history', 'line', 'cwd', 'now']),
  stats: new Set(['history']),
  names: new Set(['history']),
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
      if (!COMMANDS.has(token as CliCommand)) throw new CliArgumentError(`Unknown command: ${token}`);
      if (command !== undefined) throw new CliArgumentError(`Unexpected argument: ${token}`, command);
      command = token as CliCommand;
      continue;
    }

    const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
    const name = match?.[1];
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
    if (command !== undefined || commandHelp || values.size > 0) {
      throw new CliArgumentError('--version cannot be combined with other arguments', command);
    }
    return { command: 'version', commandHelp: false };
  }

  const resolvedCommand = command ?? (commandHelp ? 'help' : 'repl');
  if (resolvedCommand === 'help') {
    if (values.size > 0) throw new CliArgumentError('help does not accept options', resolvedCommand);
    return { command: 'help', commandHelp: false };
  }
  if (resolvedCommand === 'version') throw new CliArgumentError('version is not a command', resolvedCommand);

  for (const name of values.keys()) {
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
  if (now !== undefined) result.now = now;
  return result;
}

export function commandUsage(command: CliCommand): string {
  switch (command) {
    case 'repl':
      return 'Usage: tabcat [repl] [--history <path>]';
    case 'import':
      return 'Usage: tabcat import [--file <path>] [--history <path>]';
    case 'simulate':
      return 'Usage: tabcat simulate [--line <text>] [--cwd <dir>] [--now <ms>] [--history <path>]';
    case 'stats':
      return 'Usage: tabcat stats [--history <path>]';
    case 'names':
      return 'Usage: tabcat names [--history <path>]';
    case 'help':
      return 'Usage: tabcat help';
    case 'version':
      return 'Usage: tabcat --version';
  }
}
