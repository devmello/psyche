import { rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  deleteAgentThreadState,
  deleteLibraryItem,
  deleteThread,
  deleteToolPayloadsBefore,
  expireRunFramesBefore,
  expireRunStepText,
  getSetting,
  listExpiredThreads,
  type PsycheDb,
  pruneIdempotencyRecords,
  threadActivity,
} from "@psyche/db";
import { SCREEN_CAPTURE_TTL_MS } from "@psyche/protocol";
import type { GatewayContext } from "./context.ts";

/** Default for the `cleanupPeriodDays` setting (data model §12). */
export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;
/** Idempotency results are kept this long; clients retry within minutes. */
export const IDEMPOTENCY_RETENTION_DAYS = 7;
export const RETENTION_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface RetentionReport {
  toolPayloads: number;
  expiredThreads: string[];
  idempotencyRecords: number;
  /** Thinking steps whose retained text was blanked (run trace §4.3). */
  thinking: number;
  /** Frames whose image was removed. */
  frames: number;
}

/** Run trace §4.3: Off · 1 · 7 · 30 days; Off (0) keeps only the summary line. */
export const DEFAULT_REASONING_RETENTION_DAYS = 7;
/** Run trace §4.3: frames Psyche saw; Off (0) keeps none past the run. */
export const DEFAULT_REPLAY_RETENTION_DAYS = 7;

function retentionDays(db: PsycheDb, key: string, fallback: number): number {
  const value = getSetting(db, key)?.value;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/** `data.reasoningRetentionDays`: how long a thinking step's full text is kept. */
export function reasoningRetentionDays(db: PsycheDb): number {
  return retentionDays(db, "data.reasoningRetentionDays", DEFAULT_REASONING_RETENTION_DAYS);
}

/** `data.replayRetentionDays`: how long the frames Psyche saw are kept. */
export function replayRetentionDays(db: PsycheDb): number {
  return retentionDays(db, "data.replayRetentionDays", DEFAULT_REPLAY_RETENTION_DAYS);
}

/** Where a run's frames live: `$PSYCHE_HOME/library/recordings/<runId>/`. */
export function runRecordingsDir(home: string, runId: string): string {
  return join(home, "library", "recordings", runId);
}

/** Removes a frame file, never outside its run's folder. */
export function removeFrameFile(home: string, runId: string, path: string): void {
  const dir = resolve(runRecordingsDir(home, runId));
  const file = resolve(dir, path);
  if (!file.startsWith(`${dir}${sep}`)) return;
  rmSync(file, { force: true });
}

/** Library tag of Ask about my screen frames (`library/screen/<id>.jpg`). */
export const SCREEN_TAG = "screen";

/** Removes a screen frame file, never outside `library/screen/`. */
export function removeScreenFrame(home: string, path: string): void {
  const dir = resolve(home, "library", "screen");
  const file = resolve(home, "library", path);
  if (file.startsWith(`${dir}${sep}`)) rmSync(file, { force: true });
}

/**
 * Ask about my screen frames (docs/design/screen-ask-2026.md §5) older than `beforeIso` (sent ones
 * follow `data.replayRetentionDays`), or unsent ones (no thread) older than `unsentBeforeIso`.
 */
export function expireScreenFrames(
  db: PsycheDb,
  home: string,
  beforeIso: string,
  unsentBeforeIso: string,
): number {
  const rows = db.sqlite
    .prepare(
      `SELECT id, path FROM library_items
       WHERE EXISTS (SELECT 1 FROM json_each(library_items.tags) WHERE value = ?)
         AND (created_at < ? OR (thread_id IS NULL AND created_at < ?))`,
    )
    .all(SCREEN_TAG, beforeIso, unsentBeforeIso) as { id: string; path: string }[];
  for (const r of rows) {
    removeScreenFrame(home, r.path);
    deleteLibraryItem(db, r.id);
  }
  return rows.length;
}

export function cleanupPeriodDays(ctx: GatewayContext): number {
  const value = getSetting(ctx.db, "cleanupPeriodDays")?.value;
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : DEFAULT_CLEANUP_PERIOD_DAYS;
}

/**
 * Retention sweep (data model §12): level-3 tool payloads older than `cleanupPeriodDays`, expired
 * incognito threads (unless a run is still writing to them), and old idempotency results.
 * Receipts and audit entries are never touched.
 */
export function runRetention(ctx: GatewayContext): RetentionReport {
  const { db, bus } = ctx;
  const now = ctx.now();
  const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const report: RetentionReport = {
    toolPayloads: 0,
    expiredThreads: [],
    idempotencyRecords: 0,
    thinking: 0,
    frames: 0,
  };
  let frameFiles: { runId: string; seq: number; path: string }[] = [];
  db.sqlite.transaction(() => {
    report.toolPayloads = deleteToolPayloadsBefore(db, iso(cleanupPeriodDays(ctx) * DAY_MS));
    const expired = listExpiredThreads(db, now.toISOString());
    const activity = threadActivity(
      db,
      expired.map((t) => t.id),
    );
    for (const thread of expired) {
      // Still in use: a run is writing, or waiting for an approval or an answer.
      if ((thread.activeWriterRunId ?? null) !== null) continue;
      const a = activity.get(thread.id);
      if (a && a.running + a.awaitingApproval + a.awaitingInput > 0) continue;
      deleteThread(db, thread.id);
      deleteAgentThreadState(db, thread.id);
      report.expiredThreads.push(thread.id);
    }
    report.idempotencyRecords = pruneIdempotencyRecords(
      db,
      iso(IDEMPOTENCY_RETENTION_DAYS * DAY_MS),
    );
    // Run trace §4.3: thinking text past its expiresAt, frames past data.replayRetentionDays.
    report.thinking = expireRunStepText(db, now.toISOString());
    frameFiles = expireRunFramesBefore(
      db,
      iso(replayRetentionDays(db) * DAY_MS),
      now.toISOString(),
    );
    report.frames = frameFiles.length;
    if (
      report.toolPayloads > 0 ||
      report.expiredThreads.length > 0 ||
      report.thinking > 0 ||
      report.frames > 0
    )
      bus.bumpStateVersion();
  })();
  try {
    report.frames += expireScreenFrames(
      db,
      ctx.config.home,
      iso(replayRetentionDays(db) * DAY_MS),
      iso(SCREEN_CAPTURE_TTL_MS),
    );
  } catch (err) {
    ctx.log.log("warn", "screen frames not removed", {
      code: (err as { code?: string }).code ?? null,
    });
  }
  for (const f of frameFiles) {
    try {
      removeFrameFile(ctx.config.home, f.runId, f.path);
    } catch (err) {
      ctx.log.log("warn", "frame file not removed", {
        code: (err as { code?: string }).code ?? null,
      });
    }
  }
  for (const threadId of report.expiredThreads)
    bus.publish("thread.deleted", { threadId }, threadId);
  if (
    report.toolPayloads > 0 ||
    report.expiredThreads.length > 0 ||
    report.thinking > 0 ||
    report.frames > 0
  ) {
    ctx.log.log("info", "retention sweep", {
      toolPayloads: report.toolPayloads,
      threads: report.expiredThreads.length,
      thinking: report.thinking,
      frames: report.frames,
    });
  }
  return report;
}
