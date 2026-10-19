-- S01 Gateway core. docs/04-data-model.md §1 (pairing request key fingerprint, transport and
-- address; S23 review PR-1-B), §2 (follow-up queue, level-3 tool payloads), §11 (persisted
-- idempotency results) and §12 (retention). Conventions as in 202610182200_db_init.sql.

-- §1 Pairing requests name the key the owner approves and where the device connected from.
ALTER TABLE pairing_requests ADD COLUMN public_key_fingerprint TEXT;
ALTER TABLE pairing_requests ADD COLUMN transport TEXT
  CHECK (transport IS NULL OR transport IN ('ws', 'unix'));
ALTER TABLE pairing_requests ADD COLUMN remote_address TEXT;
CREATE INDEX pairing_requests_remote_address_idx ON pairing_requests (remote_address, created_at)
  WHERE remote_address IS NOT NULL;

-- §2 Follow-ups queued while a turn runs (feature E3). The id becomes the user message id when the
-- item starts, so a retried chat.send and the transcript agree on it.
CREATE TABLE chat_queue (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(attachments) AND json_type(attachments) = 'array'),
  device_id TEXT REFERENCES devices (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'started', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX chat_queue_thread_idx ON chat_queue (thread_id, status, position);

-- §2 Level-3 tool I/O (full params / results / screenshots), deleted after cleanupPeriodDays
-- (§12). tool_calls.result_ref points here as "payload:<id>".
CREATE TABLE tool_payloads (
  id TEXT PRIMARY KEY NOT NULL,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('params', 'result', 'screenshot')),
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX tool_payloads_created_at_idx ON tool_payloads (created_at);
CREATE INDEX tool_payloads_tool_call_id_idx ON tool_payloads (tool_call_id);

-- §11 Results of side-effecting requests, replayed for a retried idempotency key (feature A2).
-- Written in the same transaction as the mutation, so a crash never leaves one without the other.
CREATE TABLE gateway_idempotency (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL,
  method TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK (json_valid(result)),
  created_at TEXT NOT NULL,
  UNIQUE (device_id, method, idempotency_key)
);
CREATE INDEX gateway_idempotency_created_at_idx ON gateway_idempotency (created_at);
