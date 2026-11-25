import {
  appendMessage,
  failOpenRunSteps,
  finishRun,
  getRun,
  listRunsByStatus,
  markAllNodesOffline,
  markInterruptedToolCalls,
  type PsycheDb,
  settleRunToolCalls,
} from "@psyche/db";
import { type ApprovalRequest, GATEWAY_RESTART_NOTE, type Message } from "@psyche/protocol";
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
      if (report.failedRuns.includes(runId)) appendRestartNote(db, id, runId);
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

/**
 * The owner's message that started the run, for "Try again": the newest message with `owner`
 * provenance before the run's first message (or, when it has none, before it started). Peers,
 * designated people and the agent store their turns as `user` too, but not as `owner`, so a
 * resend never names words the owner did not write. None found: no action.
 */
function ownerMessageIdBefore(db: PsycheDb, threadId: string, runId: string): string | undefined {
  const first = db.sqlite
    .prepare("SELECT min(seq) AS seq FROM messages WHERE thread_id = ? AND run_id = ?")
    .get(threadId, runId) as { seq: number | null } | undefined;
  const run = getRun(db, runId);
  if (run === undefined) return undefined;
  const row =
    first?.seq == null
      ? (db.sqlite
          .prepare(
            "SELECT id FROM messages WHERE thread_id = ? AND role = 'user' AND provenance = 'owner' AND created_at <= ? ORDER BY seq DESC LIMIT 1",
          )
          .get(threadId, run.startedAt) as { id: string } | undefined)
      : (db.sqlite
          .prepare(
            "SELECT id FROM messages WHERE thread_id = ? AND role = 'user' AND provenance = 'owner' AND seq < ? ORDER BY seq DESC LIMIT 1",
          )
          .get(threadId, first.seq) as { id: string } | undefined);
  return row?.id;
}

/** The restart note, with a one-tap "Try again" that resends the owner's last message. */
function appendRestartNote(db: PsycheDb, threadId: string, runId: string): void {
  const retryOf = ownerMessageIdBefore(db, threadId, runId);
  const block: Message["blocks"][number] = {
    type: "text",
    md: GATEWAY_RESTART_NOTE.md,
    noteKey: GATEWAY_RESTART_NOTE.key,
    ...(retryOf === undefined
      ? {}
      : { noteAction: { kind: "retry_last_message" as const, messageId: retryOf } }),
  };
  appendMessage(
    db,
    { threadId, role: "system", blocks: [block], provenance: "system", runId },
    { expectedWriterRunId: null },
  );
}

/**
 * Chat turns that waited on an approval card when the Gateway stopped (audit section 3, owner's D1).
 * The loop that awaited the card died with the process, so a re-issued card would have nobody
 * behind it: approving it would do nothing and the run would stay "waiting" for good. Each such
 * run finishes as `failed: gateway_restart` with the restart note and its "Try again", and the
 * returned run ids go to `broker.reissue({ stopRuns })`, which invalidates their cards instead of
 * re-issuing them. Only an owner chat card that nothing set aside counts: an unattended run's
 * set-aside card and a task's card keep today's re-issue, because their resume needs it.
 * `alreadyFailed` are the runs the boot sweep failed (`running` when the process died).
 */
export function stopRunsWaitingOnApproval(
  db: PsycheDb,
  pending: readonly ApprovalRequest[],
  alreadyFailed: readonly string[],
  log: Logger,
): Set<string> {
  const stopped = new Set<string>();
  db.sqlite.transaction(() => {
    for (const a of pending) {
      const runId = a.requestedBy.runId;
      if (runId == null || stopped.has(runId)) continue;
      if (a.status !== "pending" || a.setAside === true || a.requestedBy.taskId != null) continue;
      const run = getRun(db, runId);
      if (run === undefined) continue;
      if (alreadyFailed.includes(runId)) {
        stopped.add(runId);
        continue;
      }
      if (run.status !== "awaiting_approval") continue;
      finishRun(db, runId, { status: "failed", error: RESTART_ERROR });
      settleRunToolCalls(db, runId);
      failOpenRunSteps(db, runId);
      appendRestartNote(db, run.threadId, runId);
      stopped.add(runId);
    }
  })();
  if (stopped.size > 0) {
    log.log("warn", "stopped chat turns waiting on an approval", { runs: stopped.size });
  }
  return stopped;
}
