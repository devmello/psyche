import type Database from "better-sqlite3";

/**
 * Rollback for migration 202611250900_memory_trust-leak.sql (memory wave 2A). The migration
 * copied each moved fact's old state to `memory_migration_backup_2026_11`; this puts it back.
 *
 * A row goes back to `accepted` only when that leaves one current value:
 * - it had replaced a trusted value: only if that value is still current (the migration made it
 *   so) and nothing newer replaced it since; the value is superseded again as it was;
 * - it had replaced nothing: only if no row for the same entity and attribute was added after it
 *   that is current now.
 * Otherwise it stays `pending` for the owner to decide. A fact the owner has since confirmed,
 * edited or discarded keeps that decision, and one retention already deleted is gone.
 * Idempotent. The backup table is kept (drop it by hand once the move is accepted).
 *
 * Invoked from code or a one-off script with an open connection to the memory store (the plain
 * database, or the encrypted file once the store is encrypted): `rollbackMemoryTrustLeak(sqlite)`.
 * Returns how many facts went back to `accepted`.
 */
export function rollbackMemoryTrustLeak(
  db: Pick<Database.Database, "prepare" | "transaction">,
): number {
  const has = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("memory_migration_backup_2026_11");
  if (has === undefined) return 0;
  return db.transaction(() => {
    // Facts whose restored prior is still current, or which replaced nothing and have no newer
    // current peer. Decided before anything is changed.
    const restorable = db
      .prepare(
        `SELECT b.id AS id, b.prior_id AS prior_id, b.prior_valid_to AS prior_valid_to,
             b.prior_superseded_by AS prior_superseded_by
           FROM memory_migration_backup_2026_11 b
           JOIN graph_facts f ON f.id = b.id AND f.review = 'pending' AND f.provenance = 'untrusted'
           WHERE CASE WHEN b.prior_id IS NOT NULL THEN
               EXISTS (SELECT 1 FROM graph_facts p WHERE p.id = b.prior_id
                 AND p.superseded_by IS NULL AND p.retracted_at IS NULL)
             ELSE
               NOT EXISTS (SELECT 1 FROM graph_facts o
                 WHERE o.entity_id = f.entity_id AND o.attribute = f.attribute AND o.id <> f.id
                   AND o.rowid > f.rowid AND o.superseded_by IS NULL AND o.retracted_at IS NULL
                   AND o.review IN ('accepted', 'auto_accepted', 'edited'))
             END`,
      )
      .all() as {
      id: string;
      prior_id: string | null;
      prior_valid_to: string | null;
      prior_superseded_by: string | null;
    }[];
    const back = db.prepare(
      "UPDATE graph_facts SET review = (SELECT review FROM memory_migration_backup_2026_11 WHERE id = ?), first_seen_at = (SELECT first_seen_at FROM memory_migration_backup_2026_11 WHERE id = ?), last_seen_at = (SELECT last_seen_at FROM memory_migration_backup_2026_11 WHERE id = ?) WHERE id = ?",
    );
    const resupersede = db.prepare(
      "UPDATE graph_facts SET superseded_by = ?, valid_to = ? WHERE id = ?",
    );
    let n = 0;
    for (const r of restorable) {
      if (r.prior_id !== null) resupersede.run(r.prior_superseded_by, r.prior_valid_to, r.prior_id);
      n += back.run(r.id, r.id, r.id, r.id).changes;
    }
    return n;
  })();
}
