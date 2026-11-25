import { existsSync, statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import {
  type PsycheDb,
  pruneAutomationRuns,
  pruneNotifications,
  pruneTerminalTasks,
} from "@psyche/db";
import type { GatewayContext } from "./context.ts";

/** Operational history (terminal tasks, scheduler runs, read or resolved notifications) is kept this long. */
export const HISTORY_RETENTION_DAYS = 90;
/** Rows deleted per transaction, so a writer is never blocked for long. */
export const PRUNE_BATCH = 200;
/** One retention pass spends at most this long pruning history; the rest waits for the next pass. */
export const PRUNE_BUDGET_MS = 250;
/** Pages handed back to the file per maintenance pass (4 KiB each, about 4 MiB). */
export const INCREMENTAL_VACUUM_PAGES = 1000;
/** A one-time VACUUM rewrites the file: it needs about twice its size free, plus this margin. */
export const VACUUM_MARGIN_BYTES = 64 * 1024 * 1024;

export interface HistoryPruneReport {
  tasks: number;
  automationRuns: number;
  notifications: number;
  /** True when the time budget ran out with more left to delete. */
  truncated: boolean;
}

/**
 * Prunes the history tables in small batches under a time budget. Order matters: notifications
 * first (they pin tasks), scheduler runs next (they pin tasks too), tasks last.
 */
export function pruneHistory(
  db: PsycheDb,
  now: Date,
  opts: { batch?: number; budgetMs?: number; clock?: () => number } = {},
): HistoryPruneReport {
  const batch = opts.batch ?? PRUNE_BATCH;
  const clock = opts.clock ?? (() => performance.now());
  const deadline = clock() + (opts.budgetMs ?? PRUNE_BUDGET_MS);
  const cutoff = new Date(now.getTime() - HISTORY_RETENTION_DAYS * 86_400_000).toISOString();
  const report: HistoryPruneReport = {
    tasks: 0,
    automationRuns: 0,
    notifications: 0,
    truncated: false,
  };
  const steps: [keyof Omit<HistoryPruneReport, "truncated">, typeof pruneTerminalTasks][] = [
    ["notifications", pruneNotifications],
    ["automationRuns", pruneAutomationRuns],
    ["tasks", pruneTerminalTasks],
  ];
  for (const [key, fn] of steps) {
    for (;;) {
      if (clock() >= deadline) {
        report.truncated = true;
        return report;
      }
      const n = fn(db, cutoff, batch);
      report[key] += n;
      if (n < batch) break;
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

export type VacuumOutcome =
  | "done"
  | "not-needed"
  | "skipped-memory"
  | "skipped-busy"
  | "skipped-low-disk"
  | "failed";

/**
 * The one-time conversion of an existing database to `auto_vacuum=INCREMENTAL`, which also
 * reclaims the free pages it has built up. Only when nothing is running and the disk has room
 * for the copy SQLite makes (about twice the file), so it never fills the owner's disk. It runs
 * from the hourly timer, never at boot. A database already converted is left alone.
 */
export function maybeVacuum(ctx: GatewayContext, freeBytes?: () => number): VacuumOutcome {
  const { db, log } = ctx;
  if (db.path === ":memory:") return "skipped-memory";
  if ((db.sqlite.pragma("auto_vacuum", { simple: true }) as number) !== 0) return "not-needed";
  if (!dbIsIdle(db)) return "skipped-busy";
  const size = fileSize(db.path) + fileSize(`${db.path}-wal`);
  const free =
    freeBytes?.() ??
    (() => {
      const s = statfsSync(dirname(db.path));
      return Number(s.bavail) * Number(s.bsize);
    })();
  if (free < size * 2 + VACUUM_MARGIN_BYTES) {
    log.log("warn", "vacuum skipped: not enough free disk", { dbBytes: size, freeBytes: free });
    return "skipped-low-disk";
  }
  const started = performance.now();
  try {
    db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    db.sqlite.pragma("auto_vacuum = INCREMENTAL");
    db.sqlite.exec("VACUUM");
    log.log("info", "vacuum done", {
      ms: Math.round(performance.now() - started),
      beforeBytes: size,
      afterBytes: fileSize(db.path),
    });
    return "done";
  } catch (err) {
    log.log("warn", "vacuum failed", {
      ms: Math.round(performance.now() - started),
      code: (err as { code?: string }).code ?? null,
    });
    return "failed";
  }
}

function fileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

/**
 * The periodic part: a bounded `incremental_vacuum` and a passive WAL checkpoint (a passive one
 * never waits for a reader, and never blocks a writer), then the one-time VACUUM when it is due.
 */
export function runDbMaintenance(ctx: GatewayContext): { vacuum: VacuumOutcome } {
  const { db, log } = ctx;
  try {
    if ((db.sqlite.pragma("auto_vacuum", { simple: true }) as number) === 2) {
      db.sqlite.pragma(`incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`);
    }
    db.sqlite.pragma("wal_checkpoint(PASSIVE)");
  } catch (err) {
    log.log("warn", "database maintenance failed", {
      code: (err as { code?: string }).code ?? null,
    });
  }
  return { vacuum: maybeVacuum(ctx) };
}
