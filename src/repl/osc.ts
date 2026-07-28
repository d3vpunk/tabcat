import { hostname } from 'node:os';

/**
 * OSC 7 sequence reporting the working directory to the terminal emulator.
 * Terminals (Ghostty, iTerm2, Terminal.app, ...) use it for "new tab in same
 * directory" — normally the interactive shell's integration emits it, but the
 * REPL replaces that shell, so without this every new tab starts at $HOME.
 *
 * Format: `ESC ] 7 ; file://<host><path> BEL`. Path segments are
 * percent-encoded (spaces, umlauts); BEL as terminator is what Apple's own
 * zsh integration uses and every relevant emulator accepts.
 */
export function osc7Cwd(cwd: string, host: string = hostname()): string {
  const encoded = cwd
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `\u001b]7;file://${host}${encoded}\u0007`;
}
