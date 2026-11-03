import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Create `$PSYCHE_HOME` and the subdirectories the bootstrap Gateway uses, all mode 0700 (architecture §14). */
export function ensureHome(home: string): void {
  for (const dir of [home, join(home, "state"), join(home, "run"), join(home, "logs")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
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
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { secret, path };
}

export function removeHandshakeSecret(path: string): void {
  rmSync(path, { force: true });
}
