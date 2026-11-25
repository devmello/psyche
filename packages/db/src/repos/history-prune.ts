import type { PsycheDb } from "../open.ts";

/**
 * Long-term growth control for operational history. It deletes no rows: it trims the bulky
 * columns of rows that stay (task checkpoint payloads, task action details, scheduler run event
 * lists), so task cards, the Activity log, search and Insights keep reading the same rows.
 *
 * Every function walks a partial index by age (`INDEXED BY`) with a keyset cursor, so a batch
 * reads at most `limit` rows however large the table is and `LIMIT` stops the walk early. A row
 * that is not eligible (a task still active) is skipped by the cursor, never re-read in a pass.
 */

export interface PruneCursor {
  at: string;
  rowid: number;
}

export interface PruneBatch {
  /** Rows trimmed in this batch. */
  changed: number;
  /** Where the next batch continues; null when the walk reached the end of the old rows. */
  next: PruneCursor | null;
}

const TERMINAL = "t.status IN ('done', 'failed', 'cancelled') AND t.lease_owner IS NULL";

function walk(
  db: PsycheDb,
  spec: { table: string; index: string; age: string; where: string; update: string },
  cutoff: string,
  limit: number,
  after: PruneCursor | null,
): PruneBatch {
  const sql = db.sqlite;
  return sql.transaction(() => {
    const rows = sql
      .prepare(
        `SELECT rowid AS rid, ${spec.age} AS at, id FROM ${spec.table} INDEXED BY ${spec.index}
         WHERE ${spec.where} AND ${spec.age} < @cutoff
           AND (@at IS NULL OR (${spec.age}, rowid) > (@at, @rid))
         ORDER BY ${spec.age}, rowid LIMIT @limit`,
      )
      .all({ cutoff, limit, at: after?.at ?? null, rid: after?.rowid ?? 0 }) as {
      rid: number;
      at: string;
      id: string;
    }[];
    const upd = sql.prepare(spec.update);
    let changed = 0;
    for (const r of rows) changed += upd.run({ id: r.id, cutoff }).changes;
    const last = rows.at(-1);
    return {
      changed,
      next: rows.length < limit || !last ? null : { at: last.at, rowid: last.rid },
    };
  })();
}

/** Checkpoint payloads of tasks that finished before `cutoff`. The rows (step, status, receipt) stay. */
export function pruneCheckpointPayloads(
  db: PsycheDb,
  cutoff: string,
  limit: number,
  after: PruneCursor | null = null,
): PruneBatch {
  return walk(
    db,
    {
      table: "task_checkpoints",
      index: "task_checkpoints_bulky_idx",
      age: "updated_at",
      where: "payload IS NOT NULL AND length(payload) > 512",
      update: `UPDATE task_checkpoints SET payload = NULL
               WHERE id = @id AND EXISTS (
                 SELECT 1 FROM tasks t WHERE t.id = task_checkpoints.task_id AND ${TERMINAL}
                   AND COALESCE(t.completed_at, t.updated_at) < @cutoff)`,
    },
    cutoff,
    limit,
    after,
  );
}

/** The detail of task actions before `cutoff`: only `level2.tool` stays, with the row and its summary. */
export function pruneActionDetails(
  db: PsycheDb,
  cutoff: string,
  limit: number,
  after: PruneCursor | null = null,
): PruneBatch {
  return walk(
    db,
    {
      table: "task_actions",
      index: "task_actions_bulky_idx",
      age: "created_at",
      where: "length(level2) > 512",
      update: `UPDATE task_actions
               SET level2 = json_object('tool', substr(COALESCE(json_extract(level2, '$.tool'), ''), 1, 200))
               WHERE id = @id`,
    },
    cutoff,
    limit,
    after,
  );
}

/** Event lists kept on finished scheduler runs started before `cutoff`. */
export function pruneRunEvents(
  db: PsycheDb,
  cutoff: string,
  limit: number,
  after: PruneCursor | null = null,
): PruneBatch {
  return walk(
    db,
    {
      table: "automation_runs",
      index: "automation_runs_events_idx",
      age: "started_at",
      where: "events IS NOT NULL",
      update: `UPDATE automation_runs SET events = NULL
               WHERE id = @id AND retry_at IS NULL
                 AND status IN ('done', 'no_reply', 'failed', 'cancelled', 'skipped')`,
    },
    cutoff,
    limit,
    after,
  );
}

/** The retention job's small persisted state (last cutoffs). */
export function getRetentionState(db: PsycheDb, key: string): string | undefined {
  const r = db.sqlite.prepare("SELECT value FROM retention_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return r?.value;
}

export function setRetentionState(db: PsycheDb, key: string, value: string): void {
  db.sqlite
    .prepare(
      "INSERT INTO retention_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}
