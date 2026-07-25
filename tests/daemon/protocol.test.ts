import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  escapeField,
  parseRequest,
  unescapeField,
} from '../../src/daemon/protocol.js';

const request = (...fields: readonly string[]): string => fields.join('\t');
const predict = (...tail: readonly string[]): string => request('predict', 'a1', String(PROTOCOL_VERSION), ...tail);

describe('protocol: field escaping', () => {
  it('escapes exactly the four framing characters', () => {
    expect(escapeField('a\tb\nc\rd\\e')).toBe('a\\tb\\nc\\rd\\\\e');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeField('git commit -m "fix: $HOME/*"')).toBe('git commit -m "fix: $HOME/*"');
  });

  it('round-trips text that contains escape-looking sequences', () => {
    // The classic single-pass trap: chained replaces would turn the escaped
    // form of a literal backslash-t into a real tab.
    for (const value of ['a\\tb', 'C:\\Users\\x', 'printf "a\\nb"', 'a\tb', 'a\nb', '\\', '\\\\', '']) {
      expect(unescapeField(escapeField(value))).toBe(value);
    }
  });

  it('keeps unknown escapes verbatim and tolerates a trailing backslash', () => {
    expect(unescapeField('a\\qb')).toBe('a\\qb');
    expect(unescapeField('trail\\')).toBe('trail\\');
  });

  it('round-trips whole messages', () => {
    const rows = [
      ['ok', 'a1', 'gi'],
      ['t status', 'git status', 'history', '', '2'],
    ];
    expect(decodeMessage(encodeMessage(rows))).toEqual(rows);
  });

  it('terminates a message with an empty line', () => {
    expect(encodeMessage([['ok', 'a1']])).toBe('ok\ta1\n\n');
  });
});

describe('protocol: multibyte cursors', () => {
  it('reads the cursor as code points, the way zsh counts', () => {
    // zsh reports 3 characters for `a😀b`; the JS string is 4 UTF-16 units.
    const parsed = parseRequest(predict('1', '3', '/x', 'a\u{1F600}b'));
    expect(parsed.ok && parsed.request.op === 'predict' && parsed.request.cursor).toBe(4);
  });

  it('leaves a plain ASCII cursor untouched', () => {
    const parsed = parseRequest(predict('1', '4', '/x', 'git commit'));
    expect(parsed.ok && parsed.request.op === 'predict' && parsed.request.cursor).toBe(4);
  });

  it('clamps a cursor past the end', () => {
    const parsed = parseRequest(predict('1', '99', '/x', 'a\u{1F600}b'));
    expect(parsed.ok && parsed.request.op === 'predict' && parsed.request.cursor).toBe(4);
  });
});

describe('protocol: framing safety', () => {
  it('drops an all-empty row so it cannot terminate the block early', () => {
    // An empty line IS the terminator: a row of empty fields would make the
    // client attribute every later response to the wrong request.
    expect(encodeMessage([['ok', 't1'], [''], ['ls -la']])).toBe('ok\tt1\nls -la\n\n');
    expect(decodeMessage(encodeMessage([['ok', 't1'], ['', ''], ['x']]))).toEqual([['ok', 't1'], ['x']]);
  });
});

describe('protocol: request parsing', () => {
  it('parses predict', () => {
    const parsed = parseRequest(predict('10', '7', '/home/x', 'git com'));
    expect(parsed).toEqual({
      ok: true,
      request: { op: 'predict', id: 'a1', limit: 10, cursor: 7, cwd: '/home/x', line: 'git com' },
    });
  });

  it('unescapes payload fields', () => {
    const parsed = parseRequest(predict('1', '5', '/tmp/a\\tb', 'echo\\t1'));
    expect(parsed.ok && parsed.request.op === 'predict' && parsed.request.cwd).toBe('/tmp/a\tb');
    expect(parsed.ok && parsed.request.op === 'predict' && parsed.request.line).toBe('echo\t1');
  });

  it('clamps a cursor past the end of the line instead of failing', () => {
    // An out-of-sync BUFFER is a client bug; erroring would cost the user
    // completion for that keystroke.
    const parsed = parseRequest(predict('1', '99', '/x', 'ls'));
    expect(parsed.ok && parsed.request.op === 'predict' && parsed.request.cursor).toBe(2);
  });

  it('parses learn with an exit code and timestamp', () => {
    const parsed = parseRequest(request('learn', 'b2', String(PROTOCOL_VERSION), '127', '1700', '/x', 'nope'));
    expect(parsed).toEqual({
      ok: true,
      request: { op: 'learn', id: 'b2', exitCode: 127, ts: 1700, cwd: '/x', line: 'nope' },
    });
  });

  it('parses names ops', () => {
    const list = parseRequest(request('names', 'c3', String(PROTOCOL_VERSION), 'list', '/x', '', ''));
    expect(list.ok && list.request.op === 'names' && list.request.sub).toBe('list');
    const create = parseRequest(request('names', 'c4', String(PROTOCOL_VERSION), 'create', '/x', 'gst', 'git status'));
    expect(create.ok).toBe(true);
  });

  it.each([
    ['unknown op', request('nope', 'a1', '1'), 'bad_op'],
    ['empty id', request('ping', '', '1'), 'bad_id'],
    ['id with control characters', request('ping', 'a\u0001', '1'), 'bad_id'],
    ['wrong field count', request('predict', 'a1', '1', '1', '/x'), 'bad_fields'],
    ['protocol mismatch', request('ping', 'a1', '99'), 'bad_protocol'],
    ['non-numeric protocol', request('ping', 'a1', 'x'), 'bad_protocol'],
    ['negative cursor', predict('1', '-1', '/x', 'ls'), 'bad_value'],
    ['limit above cap', predict('9999', '0', '/x', 'ls'), 'bad_value'],
    ['empty cwd', predict('1', '0', '', 'ls'), 'bad_value'],
    ['blank learn line', request('learn', 'a1', '1', '0', '1', '/x', '   '), 'bad_value'],
    ['learn without timestamp', request('learn', 'a1', '1', '0', '0', '/x', 'ls'), 'bad_value'],
    ['learn timestamp in microseconds', request('learn', 'a1', '1', '0', String(Date.now() * 1000), '/x', 'ls'), 'bad_value'],
    ['unknown names op', request('names', 'a1', '1', 'rename', '/x', 'gst', 'git status'), 'bad_value'],
    ['malformed handle', request('names', 'a1', '1', 'create', '/x', 'X', 'git status'), 'bad_value'],
    ['handle too short', request('names', 'a1', '1', 'create', '/x', 'gs', 'git status'), 'bad_value'],
  ])('rejects %s', (_label, line, code) => {
    const parsed = parseRequest(line);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.code).toBe(code);
  });

  it('echoes the id on failures so a client can match the response', () => {
    const parsed = parseRequest(request('predict', 'x9', '1', 'bad'));
    expect(!parsed.ok && parsed.id).toBe('x9');
  });

  it('sanitizes hostile field content in error messages', () => {
    const parsed = parseRequest(request('nope\u0007', 'a1', '1'));
    expect(!parsed.ok && parsed.message).toBe('unknown op: nope?');
  });
});
