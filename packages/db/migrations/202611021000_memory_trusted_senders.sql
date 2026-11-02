-- Everything memory EM5b: per-sender auto-accept (docs/design/everything-memory-2026.md §7.3,
-- decision 6). After the owner confirms enough facts from one contact with no discard, Psyche
-- offers to auto-accept what that person says about themselves; the answer is stored here.
-- 'trusted': their allowed self-disclosures are accepted on arrival (still untrusted provenance,
-- still undoable for a week). 'declined': do not offer again.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE memory_trusted_senders (
  entity_id TEXT PRIMARY KEY NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('trusted', 'declined')),
  decided_at TEXT NOT NULL
);
