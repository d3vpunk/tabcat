import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * `sun_path` is 104 bytes on darwin and 108 on Linux — a socket path longer
 * than that fails at bind() with a confusing ENAMETOOLONG. 100 leaves room
 * for the `.sock` name and keeps one rule for both platforms.
 */
export const MAX_SOCKET_PATH = 100;

export const SOCKET_NAME = 'daemon.sock';

/**
 * Where the daemon socket lives. Deliberately NOT next to history.jsonl in
 * ~/.config: NFS-mounted homes cannot host unix sockets at all, and a long
 * home path plus a nested config directory blows the sun_path limit.
 * $XDG_RUNTIME_DIR is the correct location when the system provides one;
 * /tmp/tabcat-<uid> is the fallback (own directory, 0700, ownership checked —
 * /tmp itself is world-writable).
 *
 * Mirrored by `_tabcat_socket_path` in the zsh plugin; both are pinned
 * together by a parity test.
 */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env, uid: number = currentUid()): string {
  const runtimeDir = env['XDG_RUNTIME_DIR'];
  const fallback = join(`/tmp/tabcat-${uid}`, SOCKET_NAME);
  if (runtimeDir === undefined || runtimeDir === '' || !isDirectory(runtimeDir)) return fallback;
  const preferred = join(runtimeDir, 'tabcat', SOCKET_NAME);
  return preferred.length > MAX_SOCKET_PATH ? fallback : preferred;
}

/**
 * Pidfile next to history.jsonl — same directory tabcat already owns and
 * creates with 0700 (`store.ts`). Unlike the socket it is an ordinary file,
 * so a home directory is fine.
 */
export const pidfileFor = (historyFile: string): string => join(dirname(historyFile), 'daemon.pid');

export class SocketPathError extends Error {}

/**
 * Creates the socket directory and refuses anything another user could have
 * planted there: a wrong owner, a symlink, or group/other permissions. Without
 * this check, a pre-created /tmp/tabcat-<uid> owned by someone else would let
 * them place their own socket where our plugin connects — and every command
 * line typed in this shell would go to them.
 */
export function ensureSocketDir(socketPath: string, uid: number = currentUid()): string {
  if (socketPath.length > MAX_SOCKET_PATH) {
    throw new SocketPathError(`socket path too long (${socketPath.length} > ${MAX_SOCKET_PATH}): ${socketPath}`);
  }
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const link = lstatSync(dir);
  if (link.isSymbolicLink()) throw new SocketPathError(`socket directory is a symlink: ${dir}`);
  const stats = statSync(dir);
  if (!stats.isDirectory()) throw new SocketPathError(`socket directory is not a directory: ${dir}`);
  // process.getuid() is undefined on Windows, where the check is meaningless.
  if (uid >= 0 && stats.uid !== uid) {
    throw new SocketPathError(`socket directory belongs to uid ${stats.uid}, expected ${uid}: ${dir}`);
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return socketPath;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const currentUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);
