import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";

/** `sun_path` holds 104 bytes on macOS and 108 on Linux, including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

export function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path, "utf8") <= MAX_SOCKET_PATH_BYTES;
}

/**
 * Where the node socket lives (issue #50). An explicit `PSYCHE_NODE_SOCKET` that is too long is an
 * error naming the variable. The default `$PSYCHE_HOME/run/node.sock`, when `$PSYCHE_HOME` is deep,
 * falls back to a private per-user directory under the temp dir (`psyche-<uid>/<hash>.sock`).
 * Clients find the actual path in `$PSYCHE_HOME/run/node-socket`.
 */
export function resolveNodeSocketPath(home: string, explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (!socketPathFits(explicit)) {
      throw new PsycheError(
        "invalid_params",
        `PSYCHE_NODE_SOCKET is ${Buffer.byteLength(explicit)} bytes; Unix socket paths are limited to ${MAX_SOCKET_PATH_BYTES} on this platform`,
      );
    }
    return explicit;
  }
  const preferred = join(home, "run", "node.sock");
  if (socketPathFits(preferred)) return preferred;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
  const fallback = join(tmpdir(), `psyche-${uid}`, `${hash}.sock`);
  if (!socketPathFits(fallback)) {
    throw new PsycheError(
      "invalid_params",
      `$PSYCHE_HOME is too deep for a Unix socket (${preferred}); set PSYCHE_NODE_SOCKET to a shorter path`,
    );
  }
  return fallback;
}

/**
 * Creates the socket's directory when it is the private fallback: mode 0700, owned by this user,
 * not a symlink. Refuses a directory someone else prepared.
 */
export function ensureSocketDir(socketPath: string, home: string): void {
  const dir = dirname(socketPath);
  if (dir === join(home, "run")) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : info.uid;
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) {
    throw new PsycheError(
      "forbidden",
      `refusing node socket directory ${dir}: not a private directory`,
    );
  }
  chmodSync(dir, 0o700);
}

/** Records the socket path for local clients (the mac helper) in `$PSYCHE_HOME/run/node-socket`. */
export function writeSocketPointer(home: string, socketPath: string): void {
  const file = join(home, "run", "node-socket");
  writeFileSync(file, `${socketPath}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
