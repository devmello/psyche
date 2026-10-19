import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
export function writeHandshakeSecret(home: string): { secret: string; path: string } {
  const secret = randomBytes(32).toString("base64url");
  const path = join(home, "run", "handshake.secret");
  rmSync(path, { force: true });
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { secret, path };
}

export function removeHandshakeSecret(path: string): void {
  rmSync(path, { force: true });
}
