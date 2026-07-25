import { HANDLE_PATTERN } from '../engine/names.js';

/**
 * Wire protocol between the zsh plugin and the daemon: one TSV line per
 * request, a TSV block terminated by an empty line per response.
 *
 * Why TSV and not JSON: the hot path runs inside zsh on every keystroke, and
 * zsh has neither a JSON parser nor a base64 builtin — JSON would mean writing
 * an encoder AND a decoder in shell script. TSV encodes with plain parameter
 * expansion (`${s//$'\t'/\\t}`) and decodes in a single pass with the `g`
 * expansion flag (`${(g::)field}`), which resolves exactly the escape set
 * below. NDJSON stays available for humans via `tabcat simulate --json`.
 *
 * Bumped only on incompatible changes: the plugin sends `protocol` with every
 * request and disables itself on a mismatch instead of misrendering.
 */
export const PROTOCOL_VERSION = 1;

/** Guards the response header: an id is echoed back verbatim, so keep it boring. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export type ErrorCode =
  | 'bad_op'
  | 'bad_id'
  | 'bad_protocol'
  | 'bad_fields'
  | 'bad_value'
  | 'warming'
  | 'too_long'
  | 'busy'
  | 'internal';

export type DaemonRequest =
  | { op: 'ping'; id: string }
  | { op: 'shutdown'; id: string }
  | { op: 'predict'; id: string; limit: number; cursor: number; cwd: string; line: string }
  | { op: 'learn'; id: string; exitCode: number; ts: number; cwd: string; line: string }
  | { op: 'names'; id: string; sub: 'list' | 'create' | 'delete' | 'resolve'; cwd: string; name: string; line: string }
  | { op: 'search'; id: string; limit: number; cwd: string; query: string };

export interface ParseFailure {
  ok: false;
  /** Echoed id when it was parseable — otherwise '-', so a client can still match. */
  id: string;
  code: ErrorCode;
  message: string;
}

export type ParseResult = { ok: true; request: DaemonRequest } | ParseFailure;

/**
 * Escapes the four characters that would otherwise break framing. Backslash
 * goes first: doing it last would re-escape the backslashes just introduced.
 */
export function escapeField(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
}

/**
 * Single left-to-right pass — a chain of `replaceAll` would turn the escaped
 * form of a literal backslash-t ('\\\\t') into a real tab. Unknown escapes
 * survive verbatim; our own encoder never emits them, so this only affects
 * hand-written debug input.
 */
export function unescapeField(value: string): string {
  if (!value.includes('\\')) return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') {
      out += value[i];
      continue;
    }
    const next = value[++i];
    if (next === undefined) out += '\\';
    else if (next === 't') out += '\t';
    else if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === '\\') out += '\\';
    else out += `\\${next}`;
  }
  return out;
}

/**
 * Rows -> wire block: every field escaped, tab-joined, empty line terminates.
 * A row whose fields are all empty is dropped: it would serialise to an empty
 * line, i.e. a second block terminator, and every following response on that
 * connection would be attributed to the wrong request.
 */
export function encodeMessage(rows: readonly (readonly string[])[]): string {
  const usable = rows.filter((row) => row.some((field) => field !== ''));
  return `${usable.map((row) => row.map(escapeField).join('\t')).join('\n')}\n\n`;
}

/** Wire block -> rows. The terminating empty line is not a row. */
export function decodeMessage(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t').map(unescapeField));
}

export const ok = (id: string, ...fields: readonly string[]): string =>
  encodeMessage([['ok', id, ...fields]]);

export const err = (id: string, code: ErrorCode, message: string): string =>
  encodeMessage([['err', id, code, message]]);

const FIELD_COUNT: Record<DaemonRequest['op'], number> = {
  ping: 3,
  shutdown: 3,
  predict: 7,
  learn: 7,
  names: 7,
  search: 6,
};

/** Clock skew a `learn` timestamp may have; beyond that it is a client bug. */
export const MAX_TS_SKEW_MS = 24 * 60 * 60_000;

/** Upper bound for `predict.limit` — the ghost asks for 1, the dropdown for ~10. */
export const MAX_PREDICT_LIMIT = 200;

const isOp = (value: string): value is DaemonRequest['op'] => value in FIELD_COUNT;

export function parseRequest(rawLine: string): ParseResult {
  const fields = rawLine.split('\t');
  const op = fields[0] ?? '';
  const rawId = fields[1] ?? '';
  // The id is validated before anything else: every later failure echoes it,
  // and an id containing control characters would corrupt the response frame.
  if (!ID_PATTERN.test(rawId)) return fail('-', 'bad_id', `invalid request id: ${truncate(rawId)}`);
  if (!isOp(op)) return fail(rawId, 'bad_op', `unknown op: ${truncate(op)}`);
  if (fields.length !== FIELD_COUNT[op]) {
    return fail(rawId, 'bad_fields', `${op} expects ${FIELD_COUNT[op]} fields, got ${fields.length}`);
  }
  const protocol = Number(fields[2]);
  if (!Number.isInteger(protocol)) return fail(rawId, 'bad_protocol', `invalid protocol: ${truncate(fields[2] ?? '')}`);
  if (protocol !== PROTOCOL_VERSION) {
    return fail(rawId, 'bad_protocol', `protocol ${protocol} not supported, daemon speaks ${PROTOCOL_VERSION}`);
  }

  const value = (index: number): string => unescapeField(fields[index] ?? '');

  switch (op) {
    case 'ping':
      return { ok: true, request: { op: 'ping', id: rawId } };
    case 'shutdown':
      return { ok: true, request: { op: 'shutdown', id: rawId } };
    case 'predict': {
      const limit = Number(fields[3]);
      if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PREDICT_LIMIT) {
        return fail(rawId, 'bad_value', `invalid limit: ${truncate(fields[3] ?? '')}`);
      }
      const cursor = Number(fields[4]);
      if (!Number.isInteger(cursor) || cursor < 0) return fail(rawId, 'bad_value', `invalid cursor: ${truncate(fields[4] ?? '')}`);
      const cwd = value(5);
      if (cwd === '') return fail(rawId, 'bad_value', 'cwd must not be empty');
      const line = value(6);
      // zsh counts the cursor in CHARACTERS (code points), JavaScript indexes
      // UTF-16 units: for `a😀b` the shell says 3 where the string is 4 long.
      // Without this conversion an emoji in the line shifts every offset and
      // Tab would splice the buffer at the wrong place.
      // A cursor past the line is a client bug (out-of-sync BUFFER); clamping
      // beats erroring — the shell would lose its completion for that keystroke.
      return {
        ok: true,
        request: { op: 'predict', id: rawId, limit, cursor: utf16IndexOf(line, cursor), cwd, line },
      };
    }
    case 'learn': {
      const exitCode = Number(fields[3]);
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 4096) {
        return fail(rawId, 'bad_value', `invalid exitCode: ${truncate(fields[3] ?? '')}`);
      }
      const ts = Number(fields[4]);
      // Upper bound too: a client sending microseconds would store entries far
      // in the future, which score as zero — learning would silently do nothing.
      if (!Number.isInteger(ts) || ts <= 0 || ts > Date.now() + MAX_TS_SKEW_MS) {
        return fail(rawId, 'bad_value', `invalid ts: ${truncate(fields[4] ?? '')}`);
      }
      const cwd = value(5);
      if (cwd === '') return fail(rawId, 'bad_value', 'cwd must not be empty');
      const line = value(6);
      if (line.trim() === '') return fail(rawId, 'bad_value', 'line must not be empty');
      return { ok: true, request: { op: 'learn', id: rawId, exitCode, ts, cwd, line } };
    }
    case 'search': {
      const limit = Number(fields[3]);
      if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PREDICT_LIMIT) {
        return fail(rawId, 'bad_value', `invalid limit: ${truncate(fields[3] ?? '')}`);
      }
      const cwd = value(4);
      if (cwd === '') return fail(rawId, 'bad_value', 'cwd must not be empty');
      return { ok: true, request: { op: 'search', id: rawId, limit, cwd, query: value(5) } };
    }
    case 'names': {
      const sub = fields[3] ?? '';
      if (sub !== 'list' && sub !== 'create' && sub !== 'delete' && sub !== 'resolve') {
        return fail(rawId, 'bad_value', `unknown names op: ${truncate(sub)}`);
      }
      const cwd = value(4);
      if (cwd === '') return fail(rawId, 'bad_value', 'cwd must not be empty');
      const name = value(5);
      const line = value(6);
      if (sub === 'create') {
        if (!HANDLE_PATTERN.test(name)) return fail(rawId, 'bad_value', `invalid handle: ${truncate(name)}`);
        if (line.trim() === '') return fail(rawId, 'bad_value', 'line must not be empty');
      }
      if (sub === 'delete' && line.trim() === '') return fail(rawId, 'bad_value', 'line must not be empty');
      if (sub === 'resolve' && !HANDLE_PATTERN.test(name)) return fail(rawId, 'bad_value', `invalid handle: ${truncate(name)}`);
      return { ok: true, request: { op: 'names', id: rawId, sub, cwd, name, line } };
    }
  }
}

/** Code-point index (what zsh reports) -> UTF-16 index (what JS strings use). */
export function utf16IndexOf(text: string, codePointIndex: number): number {
  if (codePointIndex <= 0) return 0;
  let index = 0;
  let seen = 0;
  for (const char of text) {
    if (seen >= codePointIndex) break;
    index += char.length;
    seen++;
  }
  return index;
}

/** UTF-16 length -> code points, so the shell can cut the right number of characters. */
export const codePointLength = (text: string): number => [...text].length;

const fail = (id: string, code: ErrorCode, message: string): ParseFailure => ({ ok: false, id, code, message });

/** Keeps a hostile or garbled field out of the response frame and the log. */
const truncate = (value: string): string => {
  const clean = value.replaceAll(/[^\x20-\x7e]/g, '?');
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
};
