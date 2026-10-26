-- S15 batch proposals (docs/workflows/mail-and-meetings-2026.md §8.1; #670 W2). Owner: @psyche/proactive.
-- One row per ActionProposal: the exact calls, its status and per-call results. The approval
-- itself lives in the permission store (kind `batch`); `approval_id` points at it.
CREATE TABLE action_proposals (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  calls TEXT NOT NULL CHECK (json_valid(calls) AND json_type(calls) = 'array'),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'awaiting_approval', 'running', 'done', 'partial', 'failed', 'dismissed', 'expired')
  ),
  created_by TEXT NOT NULL CHECK (json_valid(created_by)),
  thread_id TEXT,
  post_id TEXT,
  approval_id TEXT,
  taint INTEGER NOT NULL DEFAULT 0 CHECK (taint IN (0, 1)),
  taint_sources TEXT CHECK (taint_sources IS NULL OR json_valid(taint_sources)),
  results TEXT CHECK (results IS NULL OR json_valid(results)),
  undo_of TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX action_proposals_status_idx ON action_proposals (status, created_at);
CREATE INDEX action_proposals_post_idx ON action_proposals (post_id);
CREATE INDEX action_proposals_approval_idx ON action_proposals (approval_id);
