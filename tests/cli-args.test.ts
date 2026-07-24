import { describe, expect, it } from 'vitest';
import { CliArgumentError, parseCliArgs } from '../src/cli-args.js';

describe('CLI arguments', () => {
  it('accepts global history before and after the command', () => {
    expect(parseCliArgs(['--history', '/tmp/h', 'stats'])).toMatchObject({ command: 'stats', history: '/tmp/h' });
    expect(parseCliArgs(['stats', '--history=/tmp/h'])).toMatchObject({ command: 'stats', history: '/tmp/h' });
  });

  it('passes history through to the default REPL', () => {
    expect(parseCliArgs(['--history', '/tmp/h'])).toMatchObject({ command: 'repl', history: '/tmp/h' });
  });

  it('accepts the names command with an optional history path', () => {
    expect(parseCliArgs(['names'])).toMatchObject({ command: 'names' });
    expect(parseCliArgs(['names', '--history', '/tmp/h'])).toMatchObject({ command: 'names', history: '/tmp/h' });
  });

  it('accepts --minimal for the REPL, explicit and implicit', () => {
    expect(parseCliArgs(['--minimal'])).toMatchObject({ command: 'repl', minimal: true });
    expect(parseCliArgs(['repl', '--minimal', '--history', '/tmp/h'])).toMatchObject({
      command: 'repl',
      minimal: true,
      history: '/tmp/h',
    });
    expect(parseCliArgs([])).not.toHaveProperty('minimal');
  });

  it.each([
    [['simulate', '--now', 'nope'], 'Invalid value for --now'],
    [['stats', '--history'], 'Missing value for --history'],
    [['stats', '--wat'], 'Unknown option: --wat'],
    [['stats', '--line', 'x'], '--line is not valid for stats'],
    [['names', '--line', 'x'], '--line is not valid for names'],
    [['stats', '--minimal'], '--minimal is not valid for stats'],
    [['--minimal=1'], '--minimal does not take a value'],
    [['--minimal', '--minimal'], 'Option specified multiple times: --minimal'],
    [['--version', '--minimal'], '--version cannot be combined with other arguments'],
  ])('rejects invalid arguments: %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
    try {
      parseCliArgs(argv);
    } catch (error) {
      expect(error).toBeInstanceOf(CliArgumentError);
    }
  });

  it('returns command-specific help', () => {
    expect(parseCliArgs(['simulate', '--help'])).toEqual({ command: 'simulate', subs: [], commandHelp: true });
  });
});
