import {
  appendMessage,
  failOpenRunSteps,
  finishRun,
  listRunsByStatus,
  markAllNodesOffline,
  markInterruptedToolCalls,
  type PsycheDb,
  settleRunToolCalls,
} from "@psyche/db";
import type { Logger } from "./log.ts";

export const RESTART_ERROR = "gateway_restart";

export interface RecoveryReport {
  failedRuns: string[];
  uncertainToolCalls: string[];
  releasedThreads: string[];
}

/**
 * Boot-time crash recovery (features A2, D6). A run still `running` was interrupted: it fails
 * with `gateway_restart`, its writer is released, a system note is appended to the transcript,
 * and its unfinished tool calls become `uncertain` (they are never re-dispatched, so a restart
 * cannot duplicate a side effect). Turns are not re-run; the owner resends or resumes. Runs
 * awaiting an approval or input keep their status; the broker re-issues approvals.
 */
export function recoverAfterRestart(db: PsycheDb, log: Logger): RecoveryReport {
  const report: RecoveryReport = { failedRuns: [], uncertainToolCalls: [], releasedThreads: [] };
  db.sqlite.transaction(() => {
    report.uncertainToolCalls = markInterruptedToolCalls(db).map((c) => c.id);
    for (const run of listRunsByStatus(db, ["running"])) {
      finishRun(db, run.id, { status: "failed", error: RESTART_ERROR });
      // The calls are `uncertain` now; the run's committed tool blocks must say so too.
      settleRunToolCalls(db, run.id);
      // The trace too: an open step under a failed run would show as running forever.
      failOpenRunSteps(db, run.id);
      report.failedRuns.push(run.id);
    }
    const owned = db.sqlite
      .prepare(
        "SELECT id, active_writer_run_id AS runId FROM threads WHERE active_writer_run_id IS NOT NULL",
      )
      .all() as { id: string; runId: string }[];
    for (const { id, runId } of owned) {
      db.sqlite
        .prepare("UPDATE threads SET active_writer_run_id = NULL, updated_at = ? WHERE id = ?")
        .run(db.now(), id);
      report.releasedThreads.push(id);
      if (report.failedRuns.includes(runId)) {
        appendMessage(
          db,
          {
            threadId: id,
            role: "system",
            blocks: [
              { type: "text", md: "The Gateway restarted during this turn, so it was stopped." },
            ],
            provenance: "system",
            runId,
          },
          { expectedWriterRunId: null },
        );
      }
    }
    markAllNodesOffline(db);
  })();
  if (report.failedRuns.length > 0 || report.uncertainToolCalls.length > 0) {
    log.log("warn", "recovered interrupted work", {
      runs: report.failedRuns.length,
      toolCalls: report.uncertainToolCalls.length,
      threads: report.releasedThreads.length,
    });
  }
  return report;
}
