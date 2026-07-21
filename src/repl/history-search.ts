/**
 * Ctrl-R fuzzy search: substring beats subsequence, most recent hits first.
 *
 * Contract: `recentFirst` arrives NEWEST-FIRST and already deduplicated
 * (the caller caches this — otherwise every keystroke would re-deduplicate
 * the entire history).
 */
export function fuzzySearch(query: string, recentFirst: readonly string[], limit = 10): string[] {
  if (query.trim() === '') return recentFirst.slice(0, limit);

  const q = query.toLowerCase();
  return recentFirst
    .map((line, recency) => ({ line, score: matchScore(line.toLowerCase(), q, recency) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.line);
}

function matchScore(line: string, query: string, recency: number): number {
  const recencyBonus = 1 / (1 + recency / 50);
  if (line.includes(query)) return 2 + recencyBonus;
  return isSubsequence(query, line) ? 1 + recencyBonus : 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  // both sides in code points — for..of iterates code points, needle[i]
  // would index by UTF-16 unit and fail on emoji in the history
  const needleChars = [...needle];
  let i = 0;
  for (const ch of haystack) {
    if (ch === needleChars[i]) i++;
    if (i === needleChars.length) return true;
  }
  return needleChars.length === 0;
}
