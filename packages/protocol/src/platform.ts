import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync } from "node:fs";
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
 * - browser bridge: `\\.\pipe\psyche-bridge-<same hash>`
 *
 * Clients never derive the name themselves: the Gateway writes the node endpoint it listens on to
 * `$PSYCHE_HOME/run/node-socket` and the bridge endpoint to `run/browser-bridge-socket`, exactly
 * as for a Unix socket that moved under the temp dir. A named pipe has no file mode. It is
 * protected by the per-launch handshake secret (in `$PSYCHE_HOME/run`, which the Gateway limits
 * to the current user) and by the pipe's default DACL (libuv creates it with a NULL security
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

/** The named pipe a Gateway on Windows listens on for `kind`, for this `$PSYCHE_HOME`. */
export function namedPipePath(kind: LocalEndpointKind, home: string): string {
  return `\\\\.\\pipe\\psyche-${kind}-${psycheHomeHash(home)}`;
}

let cachedSid: string | null | undefined;

/**
 * A Windows system tool by absolute path: `PATH` may put another `whoami` first (Git for
 * Windows ships a POSIX one in `usr\bin`).
 */
export function system32(...path: string[]): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", ...path);
}

/** The current user's SID (`S-1-5-21-…`) on Windows, from `whoami /user`; `null` if unknown. */
export function currentUserSid(): string | null {
  if (cachedSid !== undefined) return cachedSid;
  const r = spawnSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  const m = /"(S-1-[0-9-]+)"/.exec(r.stdout ?? "");
  cachedSid = m?.[1] ?? null;
  return cachedSid;
}

/**
 * Makes `dir` private to the current user: mode 0700 on POSIX; on Windows (no file modes) its
 * DACL is replaced, inheritance from the parent removed, with full control for the current user
 * and SYSTEM only, inherited by everything created inside (`icacls /inheritance:r /grant:r`).
 * That matters when `$PSYCHE_HOME` is outside the user profile (`D:\psyche` inherits "Authenticated
 * Users: Modify" from the drive root). Returns false when Windows could not apply it (the caller
 * logs; the directory keeps the ACL it inherited).
 */
export function restrictDirToCurrentUser(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    chmodSync(dir, 0o700);
    return true;
  }
  const sid = currentUserSid();
  if (sid === null) return false;
  const r = spawnSync(
    system32("icacls.exe"),
    [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/q"],
    { windowsHide: true, timeout: 10_000 },
  );
  return r.status === 0;
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
