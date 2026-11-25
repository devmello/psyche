-- Memory wave 2A: close the trust leak (docs/design/everything-memory-2026.md 3.3, 4.5).
-- Before this change the graph model pass wrote facts it learned from other people's mail
-- (provenance 'untrusted') through GraphStore.setFact, which never set `review`, so they were
-- stored 'accepted' with no citation. GraphStore.setFact now writes them 'pending'; this
-- migration moves the rows already stored that way.
--
-- Moved: graph_facts rows that are untrusted, review = 'accepted', extractor IS NULL (written by
-- setFact, not by the EM extraction pipeline, which always sets an extractor), have no
-- graph_citations row, are current (not superseded, not retracted) and were last updated before
-- the cutoff (see below). Owner, system and agent rows, and anything the owner already confirmed
-- (edited), are never touched.
-- They go to 'pending' (the Memory > Review tab) and their last_seen_at is set to now, so the
-- existing nightly EM retention (RetentionPolicy.pendingDays, default 30) deletes them after 30
-- days unless the owner confirms them.
-- When such a row had replaced a trusted (non-untrusted) value, the newest such value on its
-- supersession chain (retracted ones skipped) is made current again.
--
-- Cutoff: a confirmed leaked row (EverythingStore.decide bumps updated_at) must never move back.
-- The caller may put the time this migration was applied in temp.trust_leak_cutoff (the
-- encrypted-store step does, from psyche.sqlite's _migrations); without it every match moves.
--
-- Backup and rollback: the old state is copied to memory_migration_backup_2026_11 first
-- (a moved table: it travels with the memory store). rollbackMemoryTrustLeak(db) in
-- packages/db/src/repos/memory-trust-rollback.ts restores it.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE IF NOT EXISTS memory_migration_backup_2026_11 (
  id TEXT PRIMARY KEY NOT NULL,
  review TEXT NOT NULL,
  first_seen_at TEXT,
  last_seen_at TEXT,
  -- A trusted value this row's chain had replaced, made current again by the migration, with
  -- what it pointed at before.
  prior_id TEXT,
  prior_valid_to TEXT,
  prior_superseded_by TEXT,
  moved_at TEXT NOT NULL
);

CREATE TEMP TABLE IF NOT EXISTS trust_leak_cutoff (value TEXT);

INSERT OR IGNORE INTO memory_migration_backup_2026_11
  (id, review, first_seen_at, last_seen_at, prior_id, prior_valid_to, prior_superseded_by, moved_at)
WITH RECURSIVE
leak(id) AS (
  SELECT f.id FROM graph_facts f
  WHERE f.provenance = 'untrusted'
    AND f.review = 'accepted'
    AND f.extractor IS NULL
    AND f.superseded_by IS NULL
    AND f.retracted_at IS NULL
    AND f.updated_at < COALESCE((SELECT value FROM temp.trust_leak_cutoff LIMIT 1), '9999-12-31')
    AND NOT EXISTS (
      SELECT 1 FROM graph_citations c WHERE c.target_kind = 'fact' AND c.target_id = f.id
    )
),
chain(leak_id, id, provenance, retracted_at, valid_to, superseded_by, depth) AS (
  SELECT l.id, p.id, p.provenance, p.retracted_at, p.valid_to, p.superseded_by, 1
  FROM leak l JOIN graph_facts p ON p.superseded_by = l.id
  UNION ALL
  SELECT c.leak_id, p.id, p.provenance, p.retracted_at, p.valid_to, p.superseded_by, c.depth + 1
  FROM chain c JOIN graph_facts p ON p.superseded_by = c.id
  WHERE (c.provenance = 'untrusted' OR c.retracted_at IS NOT NULL) AND c.depth < 50
),
best AS (
  SELECT leak_id, id, valid_to, superseded_by, min(depth) AS depth FROM chain
  WHERE provenance <> 'untrusted' AND retracted_at IS NULL
  GROUP BY leak_id
)
SELECT f.id, f.review, f.first_seen_at, f.last_seen_at, b.id, b.valid_to, b.superseded_by,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM leak l
JOIN graph_facts f ON f.id = l.id
LEFT JOIN best b ON b.leak_id = l.id;

UPDATE graph_facts SET superseded_by = NULL, valid_to = NULL
WHERE id IN (SELECT prior_id FROM memory_migration_backup_2026_11 WHERE prior_id IS NOT NULL)
  AND superseded_by IS NOT NULL;

UPDATE graph_facts SET
  review = 'pending',
  first_seen_at = COALESCE(first_seen_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (SELECT id FROM memory_migration_backup_2026_11)
  AND provenance = 'untrusted'
  AND review = 'accepted'
  AND extractor IS NULL
  AND updated_at < COALESCE((SELECT value FROM temp.trust_leak_cutoff LIMIT 1), '9999-12-31');

DROP TABLE temp.trust_leak_cutoff;

-- Marks the move as done wherever the backup table goes (the encrypted store reads it).
INSERT OR IGNORE INTO memory_migration_backup_2026_11 (id, review, moved_at)
VALUES ('applied:202611250900', 'applied', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
