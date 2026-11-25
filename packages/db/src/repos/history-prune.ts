import type { PsycheDb } from "../open.ts";

/**
 * Long-term growth control for the operational history tables (terminal tasks and their
 * checkpoints and actions, scheduler runs, resolved or read notifications). Every function
 * deletes at most `limit` rows in one short transaction and returns how many it removed, so a
 * caller loops under its own time budget.
 *
 * Never touched: threads, messages, memory, Library items, receipts, approvals, grants and the
 * audit log. A task that any of those still point at is kept (see {@link TASK_REFERENCES}).
 */

/** Tables whose rows point at a task by id. A task named here is not pruned. */
const TASK_REFERENCES = [
  "SELECT 1 FROM receipts r WHERE r.task_id = t.id",
  "SELECT 1 FROM approvals a WHERE a.task_id = t.id",
  "SELECT 1 FROM grants g WHERE g.task_id = t.id",
  "SELECT 1 FROM library_items l WHERE l.task_id = t.id",
  "SELECT 1 FROM goal_links gl WHERE gl.task_id = t.id",
  "SELECT 1 FROM credential_uses cu WHERE cu.task_id = t.id",
  "SELECT 1 FROM input_requests ir WHERE ir.task_id = t.id",
  "SELECT 1 FROM notifications n WHERE n.task_id = t.id",
  "SELECT 1 FROM automation_runs ar WHERE ar.task_id = t.id",
  "SELECT 1 FROM graph_interactions gi WHERE gi.kind = 'task' AND instr(gi.external_ref, t.id) > 0",
  // A child task still points at its parent through the specialist record.
  "SELECT 1 FROM tasks c WHERE c.id <> t.id AND c.specialist IS NOT NULL AND instr(c.specialist, t.id) > 0",
];

const TERMINAL_TASK = "('done', 'failed', 'cancelled')";

/**
 * Terminal tasks finished before `cutoff` (checkpoints and actions go with them through the
 * foreign keys). `runs.task_id` is cleared so no run points at a missing task.
 */
export function pruneTerminalTasks(db: PsycheDb, cutoff: string, limit: number): number {
  const sql = db.sqlite;
  return sql.transaction(() => {
    const ids = (
      sql
        .prepare(
          `SELECT t.id FROM tasks t
           WHERE t.status IN ${TERMINAL_TASK}
             AND t.lease_owner IS NULL
             AND COALESCE(t.completed_at, t.updated_at) < @cutoff
             AND t.updated_at < @cutoff
             ${TASK_REFERENCES.map((q) => `AND NOT EXISTS (${q})`).join("\n             ")}
           ORDER BY t.updated_at
           LIMIT @limit`,
        )
        .all({ cutoff, limit }) as { id: string }[]
    ).map((r) => r.id);
    if (ids.length === 0) return 0;
    const clear = sql.prepare("UPDATE runs SET task_id = NULL WHERE task_id = ?");
    const del = sql.prepare("DELETE FROM tasks WHERE id = ?");
    for (const id of ids) {
      clear.run(id);
      del.run(id);
    }
    return ids.length;
  })();
}

/**
 * Finished scheduler runs started before `cutoff`, except the newest run of each automation (its
 * "last run"). `runs.automation_run_id` is cleared so no run points at a missing row. A run still
 * waiting on a retry is kept.
 */
export function pruneAutomationRuns(db: PsycheDb, cutoff: string, limit: number): number {
  const sql = db.sqlite;
  return sql.transaction(() => {
    const ids = (
      sql
        .prepare(
          `SELECT ar.id FROM automation_runs ar
           WHERE ar.status IN ('done', 'no_reply', 'failed', 'cancelled', 'skipped')
             AND ar.retry_at IS NULL
             AND ar.started_at < @cutoff
             AND ar.id <> COALESCE((
               SELECT n.id FROM automation_runs n WHERE n.automation_id = ar.automation_id
               ORDER BY n.started_at DESC, n.id DESC LIMIT 1), '')
           ORDER BY ar.started_at
           LIMIT @limit`,
        )
        .all({ cutoff, limit }) as { id: string }[]
    ).map((r) => r.id);
    if (ids.length === 0) return 0;
    const clear = sql.prepare(
      "UPDATE runs SET automation_run_id = NULL WHERE automation_run_id = ?",
    );
    const del = sql.prepare("DELETE FROM automation_runs WHERE id = ?");
    for (const id of ids) {
      clear.run(id);
      del.run(id);
    }
    return ids.length;
  })();
}

/**
 * Notifications created before `cutoff` that were resolved or read. An unresolved approval or
 * question is kept however old: the owner may still have to answer it. Deliveries go with them
 * (foreign key); a kept scheduler run's `notification_id` is never left dangling.
 */
export function pruneNotifications(db: PsycheDb, cutoff: string, limit: number): number {
  return db.sqlite
    .prepare(
      `DELETE FROM notifications WHERE id IN (
         SELECT n.id FROM notifications n
         WHERE n.created_at < @cutoff
           AND n.updated_at < @cutoff
           AND (n.resolved_at IS NOT NULL
                OR (n.read_at IS NOT NULL AND n.kind NOT IN ('approval', 'input_needed')))
           AND NOT EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.notification_id = n.id)
         ORDER BY n.created_at
         LIMIT @limit)`,
    )
    .run({ cutoff, limit }).changes;
}
