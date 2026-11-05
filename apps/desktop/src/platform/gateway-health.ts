import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The parts of Gateway supervision that do not depend on the service manager: the health probe,
 * the wait that tolerates a long data migration, and the notes the Gateway leaves in
 * `$PSYCHE_HOME/run` when an update fails. Shared by the launchd and systemd supervisors.
 */

/** A progress note older than this is a Gateway that died while updating, not one that is busy. */
const UPDATE_PROGRESS_FRESH_MS = 5 * 60_000;
/** Never wait longer than this for an update to finish, whatever the note says. */
const UPDATE_WAIT_CEILING_MS = 15 * 60_000;

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function probeHealth(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The Gateway is copying the data or migrating it (`run/update-progress.json`, still fresh). */
export function updateInProgress(psycheHome: string): boolean {
  try {
    const note = JSON.parse(
      readFileSync(join(psycheHome, "run", "update-progress.json"), "utf8"),
    ) as {
      at?: unknown;
    };
    const at = typeof note.at === "string" ? Date.parse(note.at) : Number.NaN;
    return Number.isFinite(at) && Date.now() - at < UPDATE_PROGRESS_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * Waits for `/healthz`. A big database can take minutes to copy and migrate: after the deadline,
 * keep waiting while the Gateway says it is doing that, up to a ceiling, instead of reporting a
 * failure under it.
 */
export async function waitForHealthy(o: {
  healthy: () => Promise<boolean>;
  psycheHome: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const started = Date.now();
  const deadline = started + (o.timeoutMs ?? 60_000);
  for (;;) {
    if (await o.healthy()) return true;
    if (Date.now() >= deadline) {
      if (!updateInProgress(o.psycheHome) || Date.now() - started >= UPDATE_WAIT_CEILING_MS)
        return false;
    }
    await (o.sleep ?? defaultSleep)(500);
  }
}

/**
 * Why the Gateway refused to start when it undid a failed data migration (it leaves a plain
 * sentence in `run/update-failed.json`): shown in place of "did not answer". Only for the build
 * this app ships, so a note from an older build never explains a new failure.
 */
export function readUpdateFailure(
  psycheHome: string,
  expectedBuild: string | undefined,
): { message: string; restoreInterrupted: boolean } | undefined {
  try {
    const note = JSON.parse(
      readFileSync(join(psycheHome, "run", "update-failed.json"), "utf8"),
    ) as {
      message?: unknown;
      build?: unknown;
      key?: unknown;
    };
    if (typeof note.message !== "string" || note.message === "") return undefined;
    if (expectedBuild !== undefined && note.build !== expectedBuild) return undefined;
    return {
      message: note.message.slice(0, 600),
      restoreInterrupted: note.key === "restore-interrupted",
    };
  } catch {
    return undefined;
  }
}

/**
 * The splash's Retry after a failed update was undone: forget the note that makes the Gateway
 * refuse the same build on the same data, so the next start tries the update again. True when a
 * note existed.
 */
export function clearUpdateFailure(
  psycheHome: string,
  opts: { restoredByHand?: boolean },
  exists: (path: string) => boolean,
): boolean {
  const note = join(psycheHome, "run", "update-failed.json");
  const had = exists(note);
  rmSync(note, { force: true });
  // Only for an owner who has put their data back themselves after a restore that could not be
  // finished; without it the Gateway tries to finish that restore again.
  if (opts.restoredByHand === true)
    rmSync(join(psycheHome, "run", "restore-in-progress.json"), { force: true });
  return had;
}
