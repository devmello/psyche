-- Memory wave 2A: close the trust leak (docs/design/everything-memory-2026.md 3.3, 4.5).
-- Before this change the graph model pass wrote facts it learned from other people's mail
-- (provenance 'untrusted') through GraphStore.setFact, which never set `review`, so they were
-- stored 'accepted' with no citation. GraphStore.setFact now writes them 'pending'; this
-- migration moves the rows already stored that way.
--
-- Moved: graph_facts rows that are untrusted, review = 'accepted', extractor IS NULL (written by
-- setFact, not by the EM extraction pipeline, which always sets an extractor), have no
-- graph_citations row, are current (not superseded, not retracted). Owner, system and agent rows,
-- and anything the owner already confirmed (edited), are never touched.
-- They go to 'pending' (the Memory > Review tab) and their last_seen_at is set to now, so the
-- existing nightly EM retention (RetentionPolicy.pendingDays, default 30) deletes them after 30
-- days unless the owner confirms them.
-- When such a row had replaced a trusted (non-untrusted) value, that value is made current again.
--
-- Backup and rollback: the old state is copied to memory_migration_backup_2026_11 first.
-- rollbackMemoryTrustLeak(db) in packages/db/src/repos/memory-trust-rollback.ts restores it.
-- Idempotent: the backup insert ignores rows already saved and the update only matches rows
-- still 'accepted'.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE IF NOT EXISTS memory_migration_backup_2026_11 (
  id TEXT PRIMARY KEY NOT NULL,
  review TEXT NOT NULL,
  first_seen_at TEXT,
  last_seen_at TEXT,
  -- A trusted value this row had superseded, made current again by the migration.
  prior_id TEXT,
  prior_valid_to TEXT,
  moved_at TEXT NOT NULL
);

INSERT OR IGNORE INTO memory_migration_backup_2026_11
  (id, review, first_seen_at, last_seen_at, prior_id, prior_valid_to, moved_at)
SELECT f.id, f.review, f.first_seen_at, f.last_seen_at,
  (SELECT p.id FROM graph_facts p
    WHERE p.superseded_by = f.id AND p.provenance <> 'untrusted' LIMIT 1),
  (SELECT p.valid_to FROM graph_facts p
    WHERE p.superseded_by = f.id AND p.provenance <> 'untrusted' LIMIT 1),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM graph_facts f
WHERE f.provenance = 'untrusted'
  AND f.review = 'accepted'
  AND f.extractor IS NULL
  AND f.superseded_by IS NULL
  AND f.retracted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM graph_citations c WHERE c.target_kind = 'fact' AND c.target_id = f.id
  );

UPDATE graph_facts SET superseded_by = NULL, valid_to = NULL
WHERE id IN (SELECT prior_id FROM memory_migration_backup_2026_11 WHERE prior_id IS NOT NULL)
  AND superseded_by IN (SELECT id FROM memory_migration_backup_2026_11);

UPDATE graph_facts SET
  review = 'pending',
  first_seen_at = COALESCE(first_seen_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (SELECT id FROM memory_migration_backup_2026_11)
  AND provenance = 'untrusted'
  AND review = 'accepted'
  AND extractor IS NULL;
