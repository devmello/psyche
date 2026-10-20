import {
  deleteAgentThreadState,
  deleteThread,
  deleteToolPayloadsBefore,
  getSetting,
  listExpiredThreads,
  pruneIdempotencyRecords,
  threadActivity,
} from "@psyche/db";
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
  const report: RetentionReport = { toolPayloads: 0, expiredThreads: [], idempotencyRecords: 0 };
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
    if (report.toolPayloads > 0 || report.expiredThreads.length > 0) bus.bumpStateVersion();
  })();
  for (const threadId of report.expiredThreads)
    bus.publish("thread.deleted", { threadId }, threadId);
  if (report.toolPayloads > 0 || report.expiredThreads.length > 0) {
    ctx.log.log("info", "retention sweep", {
      toolPayloads: report.toolPayloads,
      threads: report.expiredThreads.length,
    });
  }
  return report;
}
