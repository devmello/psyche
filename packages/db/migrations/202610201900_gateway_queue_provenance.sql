-- S01 E12 cross-thread awareness: a follow-up queued by the agent of another thread (not by the
-- owner) keeps that provenance when it starts, so the transcript shows who sent it.
ALTER TABLE chat_queue ADD COLUMN provenance TEXT NOT NULL DEFAULT 'owner'
  CHECK (provenance IN ('owner', 'agent'));
ALTER TABLE chat_queue ADD COLUMN from_thread_id TEXT REFERENCES threads (id) ON DELETE SET NULL;
