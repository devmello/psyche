import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Node-only platform helpers shared by the Gateway, `psyche-node` and the packages
 * (`@psyche/protocol/platform`; not part of the browser-safe index). One place for the few
 * things that differ between macOS/Linux and Windows below the app layer.
 *
 * Local IPC endpoints. On macOS and Linux the node transport and the browser bridge are Unix
 * sockets under `$PSYCHE_HOME/run`. On Windows they are named pipes whose names are derived from
 * the absolute `$PSYCHE_HOME`:
 *
 * - node transport: `\\.\pipe\psyche-node-<first 16 hex of sha256(absolute PSYCHE_HOME)>`
 * - browser bridge: `\\.\pipe\psyche-<first 16 hex of sha256(lower-case absolute PSYCHE_HOME)>-browser-bridge`
 *
 * Clients never derive the name themselves: the Gateway writes the node endpoint it listens on to
 * `$PSYCHE_HOME/run/node-socket` and the bridge endpoint to `run/browser-bridge-socket`, exactly
 * as for a Unix socket that moved under the temp dir. A named pipe has no file mode. It is
 * protected by the per-launch handshake secret (in `$PSYCHE_HOME/run`, which the Gateway makes
 * owner-only with `@psyche/hostfs`) and by the pipe's default DACL (libuv creates it with a NULL security
 * descriptor: full control for the creating user, SYSTEM and Administrators; read only for
 * Everyone and anonymous, which cannot open the duplex client end a node needs). libuv also
 * creates the first instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so a second listener on the
 * same name (another Gateway, or a squatter) fails with EADDRINUSE instead of sharing it.
 */

/** Whether this platform's local endpoints are named pipes instead of Unix sockets. */
export function usesNamedPipes(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/** `\\.\pipe\…` or `\\?\pipe\…`: a Windows named pipe path (case-insensitive). */
export function isNamedPipePath(path: string): boolean {
  return /^\\\\[.?]\\pipe\\[^\\]+/i.test(path);
}

/** The first 16 hex digits of sha256 of the absolute `$PSYCHE_HOME` (UTF-8). */
export function psycheHomeHash(home: string): string {
  return createHash("sha256").update(resolve(home), "utf8").digest("hex").slice(0, 16);
}

export type LocalEndpointKind = "node" | "bridge";

/**
 * The named pipe a Gateway on Windows listens on for `kind`, for this `$PSYCHE_HOME`. The two
 * names are fixed by their clients' fallbacks (used when no pointer file is there): the
 * win-helper's `psyche-node-<hash of the home as given>`, and the desktop's
 * `psyche-<hash of the home in lower case>-browser-bridge` (apps/desktop `defaultBridgePipe`).
 */
export function namedPipePath(kind: LocalEndpointKind, home: string): string {
  if (kind === "bridge") {
    const id = createHash("sha256").update(resolve(home).toLowerCase(), "utf8").digest("hex");
    return `\\\\.\\pipe\\psyche-${id.slice(0, 16)}-browser-bridge`;
  }
  return `\\\\.\\pipe\\psyche-node-${psycheHomeHash(home)}`;
}

/**
 * A Windows system tool by absolute path: `PATH` may put another one first (Git for Windows
 * ships a POSIX `whoami` in `usr\\bin`).
 */
export function system32(...path: string[]): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...path);
}

/**
 * Flushes a directory entry after a create or rename (crash safety on POSIX file systems). Windows
 * cannot open or fsync a directory handle (EPERM / EISDIR); NTFS journals the rename metadata
 * itself, so there it does nothing.
 */
export function fsyncDirSync(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
