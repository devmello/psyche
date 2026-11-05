import { closeSync, constants, existsSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * `psyche migrate --retry --restored-by-hand`: forgetting an unfinished restore of the pre-update
 * data lets the Gateway start, and one that finds no main database starts a new empty one. So
 * first check the unfinished restore is really there and every file it was putting back exists
 * (the same check as the desktop app's button), and that no Gateway holds the data folder.
 */

const SIDE_FILES: ReadonlySet<string> = new Set([
  "config.json",
  "vault/slots.json",
  "state/memory.key.json",
  "state/memory.key.escrow.json",
  "state/search.key.json",
]);

export type RestoreCheck =
  | { ok: true }
  | { ok: false; reason: "no_note" | "no_marker" | "unreadable" | "missing"; missing: string[] };

export function checkRestoredByHand(home: string): RestoreCheck {
  const read = (rel: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(home, rel), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return null;
    }
  };
  const note = read("run/update-failed.json") as { key?: unknown } | undefined | null;
  if (note === undefined || note === null || note.key !== "restore-interrupted")
    return { ok: false, reason: "no_note", missing: [] };
  const marker = read("run/restore-in-progress.json") as
    | { snapshot?: unknown; onlyDatabases?: unknown }
    | undefined
    | null;
  if (marker === undefined) return { ok: false, reason: "no_marker", missing: [] };
  if (marker === null || typeof marker.snapshot !== "string")
    return { ok: false, reason: "unreadable", missing: [] };
  const inside = relative(resolve(home, "backups", "pre-update"), resolve(marker.snapshot));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
    return { ok: false, reason: "unreadable", missing: [] };
  let manifest: { entries?: { rel?: unknown; abs?: unknown }[] };
  try {
    manifest = JSON.parse(readFileSync(join(marker.snapshot, "manifest.json"), "utf8"));
  } catch {
    return { ok: false, reason: "unreadable", missing: [] };
  }
  if (!Array.isArray(manifest.entries)) return { ok: false, reason: "unreadable", missing: [] };
  const missing: string[] = [];
  for (const e of manifest.entries) {
    if (typeof e.rel !== "string") return { ok: false, reason: "unreadable", missing: [] };
    const abs = typeof e.abs === "string" ? e.abs : undefined;
    if (marker.onlyDatabases === true && abs === undefined && SIDE_FILES.has(e.rel)) continue;
    if (!existsSync(abs ?? join(home, e.rel))) missing.push(e.rel);
  }
  return missing.length > 0 ? { ok: false, reason: "missing", missing } : { ok: true };
}

/** `O_EXLOCK`: the Gateway's kernel lock on macOS (it holds `run/gateway.lock` while it runs). */
const O_EXLOCK = 0x20;

/** Whether a running Gateway holds the data folder's lock (macOS; elsewhere the caller probes). */
export function gatewayLockHeld(home: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const fd = openSync(
      join(home, "run", "gateway.lock"),
      constants.O_RDWR | constants.O_NONBLOCK | O_EXLOCK,
    );
    closeSync(fd);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EAGAIN" || code === "EWOULDBLOCK";
  }
}
