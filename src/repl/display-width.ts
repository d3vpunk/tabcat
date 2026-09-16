import stringWidth from 'string-width';

export const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Take whole graphemes within a terminal-cell budget. */
export function takeColumns(value: string, width: number, fromEnd = false): string {
  const parts = [...graphemes.segment(value)];
  if (fromEnd) parts.reverse();
  let result = '';
  let used = 0;
  for (const { segment } of parts) {
    used += stringWidth(segment);
    if (used > Math.max(0, width)) break;
    result = fromEnd ? segment + result : result + segment;
  }
  return result;
}
