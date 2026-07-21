import { lex } from '../engine/lexer.js';

/**
 * Cursor movement in code points instead of UTF-16 units: emoji & co. are
 * surrogate pairs — a cursor between high/low surrogate plus Backspace
 * would delete half a pair and corrupt the line (turns into U+FFFD
 * when executed).
 */

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Next cursor position left of `index` (code point boundary). */
export function previousBoundary(text: string, index: number): number {
  if (index <= 0) return 0;
  if (
    index >= 2 &&
    isLowSurrogate(text.charCodeAt(index - 1)) &&
    isHighSurrogate(text.charCodeAt(index - 2))
  ) {
    return index - 2;
  }
  return index - 1;
}

/** Next cursor position right of `index` (code point boundary). */
export function nextBoundary(text: string, index: number): number {
  if (index >= text.length) return text.length;
  if (
    index + 1 < text.length &&
    isHighSurrogate(text.charCodeAt(index)) &&
    isLowSurrogate(text.charCodeAt(index + 1))
  ) {
    return index + 2;
  }
  return index + 1;
}

/**
 * Ctrl-W (zsh backward-kill-word): start of the word left of the cursor.
 * zsh's WORDCHARS include '/' and '-' among others, i.e. a "word" only ends
 * at whitespace — "vim src/app.ts|" kills "src/app.ts" entirely, not just "ts".
 */
export function previousWordBoundary(text: string, index: number): number {
  let i = index;
  // Leading: skip the whitespace run to the left, then the word itself.
  while (i > 0 && /\s/.test(text[i - 1] ?? '')) i = previousBoundary(text, i);
  while (i > 0 && !/\s/.test(text[i - 1] ?? '')) i = previousBoundary(text, i);
  return i;
}

/** Start of the last shell chunk; trailing whitespace is skipped. */
export function previousChunkBoundary(text: string, index: number): number {
  const chunks = lex(text.slice(0, index));
  let end = index;
  while (chunks.at(-1)?.kind === 'space') {
    end -= (chunks.pop()?.text.length ?? 0);
  }
  const chunk = chunks.at(-1);
  return chunk === undefined ? 0 : end - chunk.text.length;
}

/**
 * Chunk-wise accept (right arrow at end of line): end of the chunk
 * being completed from `covered` (already-typed length). If the
 * cursor sits exactly at a chunk boundary, the next chunk jumps along.
 * Tab, in contrast, always takes the whole merge.
 */
export function chunkAcceptEnd(display: string, covered: number): number {
  let end = 0;
  for (const chunk of lex(display)) {
    end += chunk.text.length;
    if (end > covered) return end;
  }
  return display.length;
}
