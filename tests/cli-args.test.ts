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

  it.each([
    [['simulate', '--now', 'nope'], 'Invalid value for --now'],
    [['stats', '--history'], 'Missing value for --history'],
    [['stats', '--wat'], 'Unknown option: --wat'],
    [['stats', '--line', 'x'], '--line is not valid for stats'],
  ])('rejects invalid arguments: %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
    try {
      parseCliArgs(argv);
    } catch (error) {
      expect(error).toBeInstanceOf(CliArgumentError);
    }
  });

  it('returns command-specific help', () => {
    expect(parseCliArgs(['simulate', '--help'])).toEqual({ command: 'simulate', commandHelp: true });
  });
});
