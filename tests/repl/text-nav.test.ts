import { describe, expect, it } from 'vitest';
import {
  chunkAcceptEnd,
  nextBoundary,
  previousBoundary,
  previousChunkBoundary,
  previousWordBoundary,
} from '../../src/repl/text-nav.js';

describe('text-nav (surrogate pairs)', () => {
  const line = 'a🎉b'; // 🎉 = 2 UTF-16 units (index 1+2)

  it('right skips the whole emoji', () => {
    expect(nextBoundary(line, 1)).toBe(3);
    expect(nextBoundary(line, 0)).toBe(1);
    expect(nextBoundary(line, line.length)).toBe(line.length);
  });

  it('left skips the whole emoji', () => {
    expect(previousBoundary(line, 3)).toBe(1);
    expect(previousBoundary(line, 1)).toBe(0);
    expect(previousBoundary(line, 0)).toBe(0);
  });

  it('backspace simulation never deletes half a pair', () => {
    const cursor = 3;
    const previous = previousBoundary(line, cursor);
    const result = line.slice(0, previous) + line.slice(cursor);
    expect(result).toBe('ab');
  });
});

describe('previousWordBoundary (Ctrl-W)', () => {
  it('word at end of line', () => {
    expect(previousWordBoundary('git status', 10)).toBe(4);
  });

  it('whitespace run is eaten along', () => {
    expect(previousWordBoundary('git commit   ', 13)).toBe(4);
  });

  it('path token is one word (zsh WORDCHARS)', () => {
    expect(previousWordBoundary('vim src/app.ts', 14)).toBe(4);
  });

  it('at start of line stays 0', () => {
    expect(previousWordBoundary('git', 0)).toBe(0);
  });

  it('emoji inside a word is not split in half', () => {
    const line = 'say a🎉b'; // 🎉 = 2 UTF-16 units
    expect(previousWordBoundary(line, line.length)).toBe(4);
  });
});

describe('previousChunkBoundary (Ctrl-Backspace)', () => {
  it('deletes the last lexer chunk and skips trailing whitespace', () => {
    expect(previousChunkBoundary('git status', 10)).toBe(4);
    expect(previousChunkBoundary('git status   ', 13)).toBe(4);
  });

  it('treats flag prefix and flag word as separate chunks', () => {
    expect(previousChunkBoundary('exec -it', 8)).toBe(6);
    expect(previousChunkBoundary('exec -', 6)).toBe(5);
  });
});

describe('chunkAcceptEnd (right arrow = chunk-wise)', () => {
  const display = 'exec -it myapp-core_redis7 sh';
  // Chunks: exec | ' ' | - | it | ' ' | myapp-core_redis7 | ' ' | sh

  it('from the start: first chunk (the word)', () => {
    expect(display.slice(0, chunkAcceptEnd(display, 0))).toBe('exec');
  });

  it('at the chunk boundary: next chunk (the space)', () => {
    expect(display.slice(0, chunkAcceptEnd(display, 4))).toBe('exec ');
  });

  it('in the middle of a typed prefix: rest of the current chunk', () => {
    expect(chunkAcceptEnd('status', 2)).toBe(6); // 'st' -> 'status'
  });

  it('flag and word are separate steps', () => {
    expect(display.slice(0, chunkAcceptEnd(display, 5))).toBe('exec -');
    expect(display.slice(0, chunkAcceptEnd(display, 6))).toBe('exec -it');
  });

  it('last chunk ends at end of string', () => {
    expect(chunkAcceptEnd(display, display.lastIndexOf('sh'))).toBe(display.length);
  });
});
