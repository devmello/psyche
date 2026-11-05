import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { isNamedPipePath, namedPipePath, usesNamedPipes } from "@psyche/protocol/platform";

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
export function resolveNodeSocketPath(
  home: string,
  explicit: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (usesNamedPipes(platform)) {
    // Windows: the node transport is a named pipe (`@psyche/protocol/platform`), never a file.
    if (explicit === undefined) return namedPipePath("node", home);
    if (!isNamedPipePath(explicit)) {
      throw new PsycheError(
        "invalid_params",
        `PSYCHE_NODE_SOCKET must be a named pipe (\\\\.\\pipe\\name) on Windows, not ${explicit}`,
      );
    }
    return explicit;
  }
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
 * Where the Host helper's VM relay delivers sandbox guests (`PeerInfo.transport: "vm-relay"`): its
 * own socket, never `node.sock`, so the Gateway can tell a relayed guest from the Host's own
 * helper whatever the guest declares. An explicit `PSYCHE_GUEST_SOCKET` that is too long is an
 * error. By default it sits next to the node socket (`node.sock` -> `guest.sock`, `<x>.sock` ->
 * `<x>-guest.sock`); when that does not fit the Gateway has no guest socket and VM guests cannot
 * connect (the Host helper still works). The Mac helper derives the same path. Sandbox guest VMs
 * are macOS only (Virtualization.framework): on Windows there is no guest socket at all.
 */
export function resolveGuestSocketPath(
  nodeSocketPath: string,
  explicit: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (usesNamedPipes(platform)) return null;
  if (explicit !== undefined) {
    if (!socketPathFits(explicit)) {
      throw new PsycheError(
        "invalid_params",
        `PSYCHE_GUEST_SOCKET is ${Buffer.byteLength(explicit)} bytes; Unix socket paths are limited to ${MAX_SOCKET_PATH_BYTES} on this platform`,
      );
    }
    return explicit;
  }
  const base = basename(nodeSocketPath);
  const name = base === "node.sock" ? "guest.sock" : `${base.replace(/\.sock$/, "")}-guest.sock`;
  const path = join(dirname(nodeSocketPath), name);
  return socketPathFits(path) ? path : null;
}

/**
 * Creates the socket's directory when it is the private fallback: mode 0700, owned by this user,
 * not a symlink. Refuses a directory someone else prepared.
 */
export function ensureSocketDir(socketPath: string, home: string): void {
  if (isNamedPipePath(socketPath)) return; // a pipe lives in the pipe namespace, not a directory
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

/**
 * Records the node endpoint for local clients (the mac / win helper, psyche-node) in
 * `$PSYCHE_HOME/run/node-socket`: a Unix socket path, or on Windows the named pipe
 * (`\\.\pipe\psyche-node-<hash>`). One line, LF-terminated.
 */
export function writeSocketPointer(home: string, socketPath: string): void {
  const file = join(home, "run", "node-socket");
  writeFileSync(file, `${socketPath}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
