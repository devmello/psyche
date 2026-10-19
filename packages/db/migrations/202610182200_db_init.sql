-- Psyche schema v0 (owner: S00 -> S01). Source of truth for DDL; src/schema.ts mirrors it.
-- docs/04-data-model.md §1 (identity, devices, nodes), §2 (threads, messages, runs, tool calls),
-- §10 (usage, settings). Conventions: TEXT ULID ids, ISO-8601 UTC timestamps as TEXT
-- (Date#toISOString, so they sort lexicographically), JSON as TEXT checked with json_valid,
-- booleans as INTEGER 0/1, created_at everywhere, updated_at on mutable tables.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

-- §1 Identity ----------------------------------------------------------------------------------

CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('macos', 'ios', 'android', 'web', 'linux')),
  role TEXT NOT NULL CHECK (role IN ('client', 'node', 'both')),
  public_key BLOB NOT NULL,                       -- raw Ed25519 public key (32 bytes)
  token_hash BLOB,                                -- hash of the scoped device token; never the token
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  paired_at TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX devices_token_hash_idx ON devices (token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE nodes (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mac-helper', 'vm-guest', 'remote', 'phone')),
  capabilities TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(capabilities) AND json_type(capabilities) = 'array'),
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'degraded')),
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX nodes_device_id_idx ON nodes (device_id);

CREATE TABLE pairing_requests (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('device', 'channel-sender')),
  code TEXT NOT NULL,
  device_id TEXT REFERENCES devices (id) ON DELETE CASCADE, -- device rows exist (paired_at NULL) before approval
  channel_id TEXT,                                -- channels table is owned by packages/channels (S10)
  sender_id TEXT,
  display TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_device_id TEXT REFERENCES devices (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pairing_requests_status_idx ON pairing_requests (status, expires_at);
CREATE INDEX pairing_requests_code_idx ON pairing_requests (code);

-- §2 Threads, messages, runs, tool calls -------------------------------------------------------
-- threads, messages and runs reference each other; SQLite resolves REFERENCES lazily, so the
-- forward references below are fine and are enforced at write time (PRAGMA foreign_keys=ON).

CREATE TABLE threads (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('main', 'side', 'incognito', 'channel', 'automation', 'subagent')),
  title TEXT NOT NULL DEFAULT '',
  title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('user', 'auto')),
  parent_thread_id TEXT REFERENCES threads (id) ON DELETE SET NULL,
  forked_from_message_id TEXT REFERENCES messages (id) ON DELETE SET NULL,
  session_key TEXT NOT NULL,
  persona_overlay TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'balanced'
    CHECK (permission_mode IN ('plan', 'manual', 'balanced', 'auto')),
  model_ref TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived_at TEXT,
  expires_at TEXT,
  -- transcript write guard (data model §2, architecture §4.2 step 6): the run allowed to append.
  active_writer_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
);
CREATE INDEX threads_last_message_at_idx ON threads (last_message_at);
CREATE INDEX threads_session_key_idx ON threads (session_key);
CREATE INDEX threads_parent_thread_id_idx ON threads (parent_thread_id);
CREATE INDEX threads_expires_at_idx ON threads (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system', 'tool')),
  blocks TEXT NOT NULL CHECK (json_valid(blocks) AND json_type(blocks) = 'array'),
  provider_native TEXT CHECK (provider_native IS NULL OR json_valid(provider_native)),
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  reply_to_message_id TEXT REFERENCES messages (id) ON DELETE SET NULL,
  channel_ref TEXT CHECK (channel_ref IS NULL OR json_valid(channel_ref)),
  run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
CREATE INDEX messages_run_id_idx ON messages (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'done', 'failed', 'cancelled', 'awaiting_approval', 'awaiting_input')
  ),
  model_ref TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error TEXT,
  usage TEXT NOT NULL
    DEFAULT '{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"reasoning":0,"costUsd":0}'
    CHECK (json_valid(usage) AND json_type(usage) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runs_thread_id_idx ON runs (thread_id, started_at);
CREATE INDEX runs_status_idx ON runs (status);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages (id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  params_redacted TEXT NOT NULL CHECK (json_valid(params_redacted)), -- placeholders kept, never secrets
  params_hash TEXT NOT NULL,
  side_effect TEXT NOT NULL
    CHECK (side_effect IN ('none', 'read', 'write', 'destructive', 'financial')),
  target TEXT CHECK (target IS NULL OR json_valid(target)),
  decision TEXT CHECK (decision IS NULL OR decision IN ('allow', 'ask', 'deny')),
  decision_rule TEXT,
  approval_id TEXT,                               -- approvals table is owned by packages/permissions (S05); no FK yet
  taint_in INTEGER NOT NULL DEFAULT 0 CHECK (taint_in IN (0, 1)),
  taint_out INTEGER NOT NULL DEFAULT 0 CHECK (taint_out IN (0, 1)),
  result_ref TEXT,
  provenance_out TEXT NOT NULL CHECK (provenance_out IN ('trusted', 'untrusted')),
  receipt_id TEXT,                                -- receipts table is owned by packages/permissions (S05); no FK yet
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'ok', 'failed', 'uncertain', 'blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tool_calls_run_id_idx ON tool_calls (run_id);
CREATE INDEX tool_calls_message_id_idx ON tool_calls (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX tool_calls_approval_id_idx ON tool_calls (approval_id) WHERE approval_id IS NOT NULL;

-- §10 Settings and usage -----------------------------------------------------------------------

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT REFERENCES runs (id) ON DELETE SET NULL,
  job TEXT,
  model_ref TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0 CHECK (input >= 0),
  output INTEGER NOT NULL DEFAULT 0 CHECK (output >= 0),
  cache_read INTEGER NOT NULL DEFAULT 0 CHECK (cache_read >= 0),
  cache_write INTEGER NOT NULL DEFAULT 0 CHECK (cache_write >= 0),
  reasoning INTEGER NOT NULL DEFAULT 0 CHECK (reasoning >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX usage_created_at_idx ON usage (created_at);
CREATE INDEX usage_run_id_idx ON usage (run_id) WHERE run_id IS NOT NULL;
