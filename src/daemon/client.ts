import { createConnection } from 'node:net';
import { PROTOCOL_VERSION, decodeMessage, encodeMessage } from './protocol.js';

export interface DaemonInfo {
  version: string;
  protocol: number;
  state: string;
  pid: number;
}

const BLOCK_END = '\n\n';

/**
 * One request, one response block, connection closed. The zsh plugin keeps a
 * persistent fd instead (a fresh connect per keystroke would be wasteful);
 * this client exists for `tabcat daemon status|stop` and for the stale-socket
 * probe at daemon startup.
 */
export function requestOnce(socketPath: string, fields: readonly string[], timeoutMs = 2_000): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      action();
    };

    socket.setTimeout(timeoutMs, () => finish(() => reject(new Error(`daemon did not answer within ${timeoutMs} ms`))));
    socket.on('error', (error) => finish(() => reject(error)));
    socket.on('close', () => finish(() => reject(new Error('daemon closed the connection without answering'))));
    socket.on('connect', () => socket.write(encodeMessage([fields])));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf(BLOCK_END);
      if (end >= 0) finish(() => resolve(decodeMessage(buffer.slice(0, end + 1))));
    });
  });
}

/** Daemon identity, or null when nothing is listening (stale socket file, dead daemon). */
export async function pingDaemon(socketPath: string, timeoutMs = 2_000): Promise<DaemonInfo | null> {
  let rows: string[][];
  try {
    rows = await requestOnce(socketPath, ['ping', 'cli', String(PROTOCOL_VERSION)], timeoutMs);
  } catch {
    return null;
  }
  const [row] = rows;
  // A protocol mismatch still answers — with `err`, and that is a live daemon.
  if (row === undefined || row[0] !== 'ok') return { version: '?', protocol: -1, state: 'incompatible', pid: -1 };
  return {
    version: row[2] ?? '?',
    protocol: Number(row[3] ?? -1),
    state: row[4] ?? '?',
    pid: Number(row[5] ?? -1),
  };
}

export async function shutdownDaemon(socketPath: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const rows = await requestOnce(socketPath, ['shutdown', 'cli', String(PROTOCOL_VERSION)], timeoutMs);
    return rows[0]?.[0] === 'ok';
  } catch {
    return false;
  }
}
