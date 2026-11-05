import { spawnSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { isOwnerOnly } from "./private.ts";

/**
 * Test support (`@psyche/hostfs/testing`): the privacy of a file as one comparable value, so a test
 * asserts "0600" on macOS/Linux and "owner-only DACL" on Windows with the same line:
 * `expect(privacyOf(f)).toBe(OWNER_FILE)`.
 */

const WIN = process.platform === "win32";

/** What `privacyOf` gives for an owner-only file: mode 0600, or `"owner-only"` on Windows. */
export const OWNER_FILE: number | "owner-only" = WIN ? "owner-only" : 0o600;
/** What `privacyOf` gives for an owner-only folder: mode 0700, or `"owner-only"` on Windows. */
export const OWNER_DIR: number | "owner-only" = WIN ? "owner-only" : 0o700;

/** The permission bits on POSIX; on Windows `"owner-only"` or `"shared"` from the DACL. */
export function privacyOf(path: string): number | "owner-only" | "shared" {
  if (!WIN) return statSync(path).mode & 0o777;
  return isOwnerOnly(path) ? "owner-only" : "shared";
}

/**
 * Lets other local users read `path`: `mode` (default 0644, 0755 for a folder) on POSIX; on Windows
 * an allow entry for the Users group (read, handed down inside a folder).
 */
export function exposeToOthers(path: string, mode?: number): void {
  const directory = statSync(path).isDirectory();
  if (!WIN) {
    chmodSync(path, mode ?? (directory ? 0o755 : 0o644));
    return;
  }
  const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
  const grant = directory ? "*S-1-5-32-545:(OI)(CI)(RX)" : "*S-1-5-32-545:(R)";
  const r = spawnSync(icacls, [path, "/grant", grant, "/q"], { windowsHide: true });
  if (r.status !== 0) throw new Error(`icacls could not expose ${path}`);
}
