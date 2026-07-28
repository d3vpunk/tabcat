import { Socket, createConnection } from 'node:net';
import { PROTOCOL_VERSION, decodeMessage, encodeMessage } from '../../src/daemon/protocol.js';

const BLOCK_END = '\n\n';

/**
 * Persistent-connection client — the same shape the zsh plugin uses (one fd,
 * many requests, responses in order). The one-shot `requestOnce` client cannot
 * exercise per-connection state like the request buffer or the connection cap.
 */
export class TestClient {
  private buffer = '';
  private readonly pending: ((rows: string[][]) => void)[] = [];
  private counter = 0;

  private constructor(private readonly socket: Socket) {
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let end = this.buffer.indexOf(BLOCK_END);
      while (end >= 0) {
        const block = this.buffer.slice(0, end + 1);
        this.buffer = this.buffer.slice(end + BLOCK_END.length);
        this.pending.shift()?.(decodeMessage(block));
        end = this.buffer.indexOf(BLOCK_END);
      }
    });
  }

  static connect(socketPath: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      socket.once('error', reject);
      socket.once('connect', () => resolve(new TestClient(socket)));
    });
  }

  /** Sends `op` with an auto-generated id plus the protocol field. */
  request(op: string, ...tail: readonly string[]): Promise<string[][]> {
    const id = `t${++this.counter}`;
    return this.send([op, id, String(PROTOCOL_VERSION), ...tail]);
  }

  /** Sends fully explicit fields — for protocol-error cases. */
  send(fields: readonly string[]): Promise<string[][]> {
    const answer = new Promise<string[][]>((resolve) => this.pending.push(resolve));
    this.socket.write(encodeMessage([fields]));
    return answer;
  }

  /** Raw bytes, no framing — used to test the request size guard. */
  writeRaw(text: string): Promise<string[][]> {
    const answer = new Promise<string[][]>((resolve) => this.pending.push(resolve));
    this.socket.write(text);
    return answer;
  }

  close(): void {
    this.socket.destroy();
  }
}

export const rowsToMap = (rows: readonly string[][]): string[][] => rows.map((row) => [...row]);

/** Waits for a promise but fails loudly instead of hanging the whole suite. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
      timer.unref();
    }),
  ]);
}
