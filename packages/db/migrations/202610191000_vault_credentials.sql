-- S06 vault: metadata mirror of vault items and the fill log (docs/04-data-model.md §6).
-- No secret values here: names, kinds, slugs, bindings, counters. Values live only in vault/vault.db.

CREATE TABLE credential_meta (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('login', 'api_key', 'oauth_token', 'ssh_key', 'note', 'payment_link', 'signing_key')),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  bindings TEXT NOT NULL CHECK (json_valid(bindings)),
  owner_connector_id TEXT,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX credential_meta_owner_idx ON credential_meta (owner_connector_id) WHERE owner_connector_id IS NOT NULL;

-- task_id / approval_id are plain TEXT: their tables belong to S04 / S05.
CREATE TABLE credential_uses (
  id TEXT PRIMARY KEY NOT NULL,
  credential_id TEXT NOT NULL REFERENCES credential_meta (id) ON DELETE CASCADE,
  task_id TEXT,
  approval_id TEXT,
  executor TEXT NOT NULL CHECK (executor IN ('browser', 'connector', 'sandbox', 'ssh')),
  target TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('filled', 'denied', 'failed')),
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX credential_uses_credential_idx ON credential_uses (credential_id, created_at);
