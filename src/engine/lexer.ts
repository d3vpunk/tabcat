export type ChunkKind = 'word' | 'sep' | 'flag' | 'quote' | 'op' | 'space';

export interface Chunk {
  text: string;
  kind: ChunkKind;
}

const SEP_CHARS = new Set(['/', '=', ':', ',', '@']);
const QUOTE_CHARS = new Set(['"', "'", '`']);
const OP_CHARS = new Set(['|', '&', ';', '<', '>', '(', ')']);

const isSpace = (ch: string): boolean => /\s/.test(ch);

const isWordChar = (ch: string): boolean =>
  !isSpace(ch) && !SEP_CHARS.has(ch) && !QUOTE_CHARS.has(ch) && !OP_CHARS.has(ch);

/**
 * Splits a command line into small chunks.
 * Invariant: join(lex(line)) === line — lossless reconstruction.
 */
export function lex(line: string): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;

  const prevKind = (): ChunkKind | null => chunks.at(-1)?.kind ?? null;

  while (i < line.length) {
    const ch = line.charAt(i);

    if (isSpace(ch)) {
      let j = i;
      while (j < line.length && isSpace(line.charAt(j))) j++;
      chunks.push({ text: line.slice(i, j), kind: 'space' });
      i = j;
      continue;
    }
    if (QUOTE_CHARS.has(ch)) {
      chunks.push({ text: ch, kind: 'quote' });
      i++;
      continue;
    }
    if (SEP_CHARS.has(ch)) {
      chunks.push({ text: ch, kind: 'sep' });
      i++;
      continue;
    }
    if (OP_CHARS.has(ch)) {
      let j = i;
      while (j < line.length && OP_CHARS.has(line.charAt(j))) j++;
      chunks.push({ text: line.slice(i, j), kind: 'op' });
      i = j;
      continue;
    }
    // Flag prefix (- or --) only at the start of a word; inside a word
    // (docker-compose) '-' remains a normal word character.
    if (ch === '-' && prevKind() !== 'word') {
      let j = i;
      while (j < line.length && line.charAt(j) === '-') j++;
      chunks.push({ text: line.slice(i, j), kind: 'flag' });
      i = j;
      continue;
    }
    let j = i;
    while (j < line.length && isWordChar(line.charAt(j))) j++;
    chunks.push({ text: line.slice(i, j), kind: 'word' });
    i = j;
  }

  return chunks;
}

export function join(chunks: readonly Chunk[]): string {
  return chunks.map((c) => c.text).join('');
}
