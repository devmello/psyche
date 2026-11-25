import { existsSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  getRetentionState,
  type PruneBatch,
  type PruneCursor,
  type PsycheDb,
  pruneActionDetails,
  pruneCheckpointPayloads,
  pruneRunEvents,
  setRetentionState,
} from "@psyche/db";
import type { GatewayContext } from "./context.ts";

const DAY_MS = 86_400_000;
/** Checkpoint payloads of finished tasks are trimmed after this long. */
export const CHECKPOINT_RETENTION_DAYS = 30;
/** Task action details and scheduler event lists are trimmed after this long. */
export const HISTORY_RETENTION_DAYS = 90;
/** Rows trimmed per transaction, so a writer is never blocked for long. */
export const PRUNE_BATCH = 200;
/** One pass spends at most this long on pruning; the rest waits for the next hourly pass. */
export const PRUNE_BUDGET_MS = 250;
/** Pages handed back to the file per maintenance pass (4 KiB each, about 4 MiB). */
export const INCREMENTAL_VACUUM_PAGES = 1000;
/** A prune that trimmed this many rows ends with a TRUNCATE checkpoint. */
export const LARGE_PRUNE_ROWS = 5000;
/** The pass is skipped when the clock is further than this past the newest task or message. */
export const CLOCK_GUARD_MS = 2 * DAY_MS;
/** A cutoff moves forward by at most the time this process measured, plus this slack, per pass. */
export const CUTOFF_SLACK_MS = DAY_MS;

export interface HistoryPruneReport {
  checkpoints: number;
  actions: number;
  runEvents: number;
  /** True when the time budget ran out with more left to trim. */
  truncated: boolean;
  /** Set when the pass did nothing on purpose: the clock looks wrong. */
  skipped?: "clock";
}

type Walker = (
  db: PsycheDb,
  cutoff: string,
  limit: number,
  after: PruneCursor | null,
) => PruneBatch;

const lastPassMono = new Map<string, number>();

/**
 * The cutoff for one prune: `now - days`, but never more than the monotonic time since this
 * process's previous pass (or since it started) plus a day past the cutoff persisted by the last
 * pass. A wall clock that jumps forward therefore cannot pull a year of rows into one pass.
 */
export function safeCutoff(
  db: PsycheDb,
  name: string,
  now: Date,
  days: number,
  mono: () => number = () => performance.now(),
): string {
  const wanted = now.getTime() - days * DAY_MS;
  const stored = getRetentionState(db, `cutoff.${name}`);
  const monoNow = mono();
  const elapsed = monoNow - (lastPassMono.get(name) ?? 0);
  lastPassMono.set(name, monoNow);
  let ms = wanted;
  if (stored !== undefined) {
    const prev = Date.parse(stored);
    if (Number.isFinite(prev)) ms = Math.min(wanted, prev + elapsed + CUTOFF_SLACK_MS);
  }
  const iso = new Date(ms).toISOString();
  setRetentionState(db, `cutoff.${name}`, iso);
  return iso;
}

/** Newest activity the Gateway has recorded: the clock must not be far past it. */
function newestActivityMs(db: PsycheDb): number {
  const row = db.sqlite
    .prepare(
      `SELECT (SELECT MAX(updated_at) FROM tasks) AS t,
              (SELECT created_at FROM messages ORDER BY rowid DESC LIMIT 1) AS m`,
    )
    .get() as { t: string | null; m: string | null };
  return Math.max(row.t ? Date.parse(row.t) || 0 : 0, row.m ? Date.parse(row.m) || 0 : 0);
}

/**
 * Trims bulky history columns in small batches under a time budget. No rows are deleted. Only
 * called from the hourly timer, never at boot.
 */
export function pruneHistory(
  db: PsycheDb,
  now: Date,
  opts: { batch?: number; budgetMs?: number; clock?: () => number; mono?: () => number } = {},
): HistoryPruneReport {
  const batch = opts.batch ?? PRUNE_BATCH;
  const clock = opts.clock ?? (() => performance.now());
  const report: HistoryPruneReport = {
    checkpoints: 0,
    actions: 0,
    runEvents: 0,
    truncated: false,
  };
  const newest = newestActivityMs(db);
  if (newest > 0 && now.getTime() - newest > CLOCK_GUARD_MS) {
    report.skipped = "clock";
    return report;
  }
  const deadline = clock() + (opts.budgetMs ?? PRUNE_BUDGET_MS);
  const steps: [keyof Omit<HistoryPruneReport, "truncated" | "skipped">, string, number, Walker][] =
    [
      ["checkpoints", "checkpoints", CHECKPOINT_RETENTION_DAYS, pruneCheckpointPayloads],
      ["actions", "actions", HISTORY_RETENTION_DAYS, pruneActionDetails],
      ["runEvents", "runEvents", HISTORY_RETENTION_DAYS, pruneRunEvents],
    ];
  for (const [key, name, days, fn] of steps) {
    const cutoff = safeCutoff(db, name, now, days, opts.mono);
    let cursor: PruneCursor | null = null;
    for (;;) {
      if (clock() >= deadline) {
        report.truncated = true;
        return report;
      }
      const r = fn(db, cutoff, batch, cursor);
      report[key] += r.changed;
      if (r.next === null) break;
      cursor = r.next;
    }
  }
  return report;
}

/** No run, task or scheduler run is executing: nothing is writing, nothing is mid-stream. */
export function dbIsIdle(db: PsycheDb): boolean {
  const busy = db.sqlite
    .prepare(
      `SELECT (SELECT COUNT(*) FROM runs WHERE status = 'running')
            + (SELECT COUNT(*) FROM tasks WHERE status = 'running')
            + (SELECT COUNT(*) FROM automation_runs WHERE status = 'running') AS n`,
    )
    .get() as { n: number };
  return busy.n === 0;
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

export interface CompactEstimate {
  dbBytes: number;
  /** `freelist_count x page_size`: what a VACUUM would give back at most. */
  reclaimableBytes: number;
  idle: boolean;
}

export function compactEstimate(db: PsycheDb): CompactEstimate {
  const pageSize = db.sqlite.pragma("page_size", { simple: true }) as number;
  const free = db.sqlite.pragma("freelist_count", { simple: true }) as number;
  return {
    dbBytes: db.path === ":memory:" ? 0 : fileSize(db.path),
    reclaimableBytes: free * pageSize,
    idle: dbIsIdle(db),
  };
}

/**
 * The owner's "Compact database": VACUUM, then a TRUNCATE checkpoint. Refused while a run, task
 * or scheduler run is active. Never called by a timer.
 */
export function compactDatabase(
  ctx: GatewayContext,
): { ok: true; ms: number; savedBytes: number } | { ok: false; reason: "busy" | "memory" } {
  const { db } = ctx;
  if (db.path === ":memory:") return { ok: false, reason: "memory" };
  if (!dbIsIdle(db)) return { ok: false, reason: "busy" };
  const before = fileSize(db.path) + fileSize(`${db.path}-wal`);
  const started = performance.now();
  db.sqlite.exec("VACUUM");
  db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  const ms = Math.round(performance.now() - started);
  const after = fileSize(db.path) + fileSize(`${db.path}-wal`);
  ctx.log.log("info", "database compacted", { ms, beforeBytes: before, afterBytes: after });
  return { ok: true, ms, savedBytes: Math.max(0, before - after) };
}

/**
 * The hourly part: trim history, hand freed pages back (only on an INCREMENTAL database) and
 * checkpoint the WAL passively (TRUNCATE after a large prune). No VACUUM here.
 */
export function runDbMaintenance(ctx: GatewayContext): HistoryPruneReport {
  const { db, log } = ctx;
  let report: HistoryPruneReport = {
    checkpoints: 0,
    actions: 0,
    runEvents: 0,
    truncated: false,
  };
  try {
    report = pruneHistory(db, ctx.now());
    const trimmed = report.checkpoints + report.actions + report.runEvents;
    if (trimmed > 0) {
      ctx.bus.bumpStateVersion();
      log.log("info", "history trimmed", { ...report });
    }
    if ((db.sqlite.pragma("auto_vacuum", { simple: true }) as number) === 2) {
      db.sqlite.pragma(`incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`);
    }
    db.sqlite.pragma(
      trimmed >= LARGE_PRUNE_ROWS ? "wal_checkpoint(TRUNCATE)" : "wal_checkpoint(PASSIVE)",
    );
  } catch (err) {
    log.log("warn", "database maintenance failed", {
      code: (err as { code?: string }).code ?? null,
    });
  }
  return report;
}
