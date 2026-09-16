/**
 * Shell syntax the engine has to understand without a shell: quoting,
 * escaping, and the word and command structure of a line. Nothing here
 * touches the model or the filesystem.
 */

export type QuoteContext = 'single' | 'double' | null;

/** Escape only filesystem-derived text; learned shell syntax must stay intact. */
export function escapeFsText(text: string, quote: QuoteContext): string {
  if (quote === 'single') return text.replaceAll("'", "'\\''");
  if (quote === 'double') return text.replace(/[\\"$`]/g, '\\$&');
  return text.replace(/[^A-Za-z0-9_@%+=:,./~-]/g, '\\$&');
}

/** Active shell quote immediately left of cursor, respecting backslash escapes. */
export function quoteContext(line: string): QuoteContext {
  let quote: QuoteContext = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== 'single' && ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" && quote !== 'double') quote = quote === 'single' ? null : 'single';
    if (ch === '"' && quote !== 'single') quote = quote === 'double' ? null : 'double';
  }
  return quote;
}

/** Decode current shell argument for filesystem lookup while retaining raw replacement length. */
export function shellPathToken(line: string): { token: string; prefix: string; rawPrefixLength: number } {
  let token = '';
  let quote: QuoteContext = null;
  let rawPrefixStart = line.length;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote !== 'single' && ch === '\\') {
      const escaped = line[i + 1];
      if (escaped !== undefined) {
        if (token === '') rawPrefixStart = i;
        token += escaped;
        i++;
      }
      continue;
    }
    if (ch === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      if (token === '') rawPrefixStart = i + 1;
      continue;
    }
    if (ch === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      if (token === '') rawPrefixStart = i + 1;
      continue;
    }
    if (quote === null && (/\s/.test(ch) || '|&;<>()='.includes(ch))) {
      token = '';
      rawPrefixStart = i + 1;
      continue;
    }
    if (token === '') rawPrefixStart = i;
    token += ch;
    if (ch === '/') rawPrefixStart = i + 1;
  }

  const slash = token.lastIndexOf('/');
  return { token, prefix: token.slice(slash + 1), rawPrefixLength: line.length - rawPrefixStart };
}

/** Outside quotes, these end a simple command. */
const COMMAND_BREAKS = new Set(['|', '&', ';', '(', ')', '\n']);
/** Outside quotes, these end a word but not the command (redirections). */
const WORD_BREAKS = new Set(['<', '>']);

/**
 * The words of the LAST simple command on the line, quotes removed and
 * escapes resolved: `git pull && cd "My Dir"` → ['cd', 'My Dir']. That is
 * the command the cursor is in — the one a per-command rule has to judge.
 */
export function simpleCommandWords(line: string): string[] {
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: QuoteContext = null;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote !== 'single' && ch === '\\') {
      const escaped = line[i + 1];
      if (escaped !== undefined) {
        word += escaped;
        inWord = true;
        i++;
      }
      continue;
    }
    if (ch === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      inWord = true;
      continue;
    }
    if (ch === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      inWord = true;
      continue;
    }
    if (quote !== null) {
      word += ch;
      continue;
    }
    if (COMMAND_BREAKS.has(ch)) {
      endWord();
      words = [];
      continue;
    }
    if (/\s/.test(ch) || WORD_BREAKS.has(ch)) {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endWord();
  return words;
}

/** Wrappers that run the command they name without changing its meaning. */
const COMMAND_WRAPPERS = new Set(['builtin', 'command']);

/**
 * Where a `cd` line goes, or null when its last simple command is not `cd`.
 * Options (`-P`, `-L`, …) are skipped and `--` ends them. '' is a bare `cd`
 * (home), '-' the previous directory — both always valid targets.
 */
export function cdTarget(line: string): string | null {
  const words = simpleCommandWords(line);
  while (words.length > 0 && COMMAND_WRAPPERS.has(words[0] as string)) words.shift();
  if (words[0] !== 'cd') return null;
  let optionsEnded = false;
  for (const word of words.slice(1)) {
    if (!optionsEnded && word === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.startsWith('-') && word !== '-') continue;
    return word;
  }
  return '';
}
