import type Database from "better-sqlite3";

/**
 * Rollback for migration 202611250900_memory_trust-leak.sql (memory wave 2A). The migration
 * copied each moved fact's old state to `memory_migration_backup_2026_11`; this puts it back.
 *
 * Only rows still `pending` are restored: a fact the owner has since confirmed, edited or
 * discarded keeps the owner's decision, and one retention already deleted is gone. A trusted
 * value the migration made current again is superseded by the restored row again.
 * Idempotent. The backup table is kept (drop it by hand once the move is accepted).
 *
 * Invoked from code or a one-off script with an open connection to the Psyche database:
 * `rollbackMemoryTrustLeak(sqlite)`. Returns how many facts went back to `accepted`.
 */
export function rollbackMemoryTrustLeak(
  db: Pick<Database.Database, "prepare" | "transaction">,
): number {
  const has = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("memory_migration_backup_2026_11");
  if (has === undefined) return 0;
  return db.transaction(() => {
    db.prepare(
      `UPDATE graph_facts SET superseded_by = (
           SELECT b.id FROM memory_migration_backup_2026_11 b WHERE b.prior_id = graph_facts.id),
         valid_to = (
           SELECT b.prior_valid_to FROM memory_migration_backup_2026_11 b
           WHERE b.prior_id = graph_facts.id)
       WHERE id IN (
         SELECT b.prior_id FROM memory_migration_backup_2026_11 b
         JOIN graph_facts f ON f.id = b.id
         WHERE b.prior_id IS NOT NULL AND f.review = 'pending' AND f.provenance = 'untrusted')
         AND superseded_by IS NULL`,
    ).run();
    return db
      .prepare(
        `UPDATE graph_facts SET
           review = (SELECT b.review FROM memory_migration_backup_2026_11 b WHERE b.id = graph_facts.id),
           first_seen_at = (SELECT b.first_seen_at FROM memory_migration_backup_2026_11 b WHERE b.id = graph_facts.id),
           last_seen_at = (SELECT b.last_seen_at FROM memory_migration_backup_2026_11 b WHERE b.id = graph_facts.id)
         WHERE id IN (SELECT id FROM memory_migration_backup_2026_11)
           AND review = 'pending' AND provenance = 'untrusted'`,
      )
      .run().changes;
  })();
}
