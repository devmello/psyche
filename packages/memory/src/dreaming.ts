import { neverPromoted } from "./provenance.ts";
import type { SqliteMemoryStore } from "./store.ts";
import { localDateTime } from "./support.ts";

/**
 * Nightly dreaming (feature H6, M2). M1 ships the scaffold: scheduling (03:00 local), candidate
 * selection that already excludes `untrusted` and `system` content, a job record and a diary
 * line in `DREAMS.md`. It does not write `MEMORY.md` yet: promotion thresholds, merging,
 * `supersedes` resolution and decay land in M2. Dreaming is the only writer of `MEMORY.md`.
 */

export const DREAMING_HOUR = 3;

/** True when a run is due: it is past 03:00 local and the last run was before today's 03:00. */
export function dreamingDue(
  nowMs: number,
  lastRunMs: number | undefined,
  timeZone: string,
): boolean {
  const now = localDateTime(nowMs, timeZone);
  if (Number(now.time.slice(0, 2)) < DREAMING_HOUR) return false;
  if (lastRunMs === undefined) return true;
  const last = localDateTime(lastRunMs, timeZone);
  return last.date < now.date || Number(last.time.slice(0, 2)) < DREAMING_HOUR;
}

export interface DreamingReport {
  candidates: number;
  excluded: number;
  promoted: number;
}

export async function runDreaming(store: SqliteMemoryStore): Promise<DreamingReport> {
  const job = store.startJob("dreaming");
  try {
    const claims = await store.listClaims();
    const active = claims.filter((c) => typeof c.supersededBy !== "string");
    const candidates = active.filter((c) => !neverPromoted(c.provenance));
    const report: DreamingReport = {
      candidates: candidates.length,
      excluded: active.length - candidates.length,
      promoted: 0,
    };
    const diary = await store.readFile("DREAMS.md");
    const entry = `\n## ${store.now().date}\n\n- Reviewed ${report.candidates} candidate(s); ${report.excluded} not eligible (untrusted or system). Promotion into MEMORY.md is not enabled yet.\n`;
    await store.write("DREAMS.md", `${(diary?.content ?? "# Dreams\n").trimEnd()}\n${entry}`, {
      provenance: "system",
      actor: "job",
      source: "job",
    });
    store.finishJob(
      job,
      "ok",
      `candidates ${report.candidates}, excluded ${report.excluded}, promoted 0`,
    );
    return report;
  } catch (err) {
    store.finishJob(job, "failed", "dreaming failed");
    throw err;
  }
}
