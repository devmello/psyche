import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restrictDirToCurrentUser } from "@psyche/protocol/platform";

/** Homes already restricted by this process (Windows: one `icacls` per home, not per start). */
const restricted = new Set<string>();

/**
 * Create `$PSYCHE_HOME` and the subdirectories the bootstrap Gateway uses, all mode 0700
 * (architecture §14). Windows has no modes: the home's DACL is set to the current user and SYSTEM
 * only, inherited by everything inside (the handshake secret in `run/` included), whatever the
 * parent directory allows.
 */
export function ensureHome(home: string, log?: (msg: string) => void): void {
  for (const dir of [home, join(home, "state"), join(home, "run"), join(home, "logs")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  }
  if (process.platform === "win32" && !restricted.has(home)) {
    if (restrictDirToCurrentUser(home)) restricted.add(home);
    else log?.(`could not restrict ${home} to the current user; it keeps its inherited ACL`);
  }
}

/**
 * Per-launch handshake secret for loopback auto-pairing (architecture §11, security §10).
 * Written to `$PSYCHE_HOME/run/handshake.secret` with mode 0600; the desktop shell and the
 * mac helper read it; a browser page cannot.
 */
export function newHandshakeSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Call after the live-Gateway check (so a failed second start never clobbers a live secret) and
 * BEFORE any socket listens: a helper that reconnects the instant the node socket opens must
 * already find this launch's secret. Written atomically (temp file, then rename over the old one)
 * so there is never a moment with no file, and a crash leaves the old secret, which the next
 * start replaces.
 */
export function writeHandshakeSecret(
  home: string,
  secret: string,
): { secret: string; path: string } {
  const path = join(home, "run", "handshake.secret");
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${secret}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameOver(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { secret, path };
}

/**
 * `rename` over an existing file. On Windows it fails with EPERM/EBUSY/EACCES for the moment a
 * reader (the helper re-reading the secret) has the old file open; that clears in milliseconds.
 */
function renameOver(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (process.platform !== "win32" || !busy || attempt >= 20) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function removeHandshakeSecret(path: string): void {
  rmSync(path, { force: true });
}
