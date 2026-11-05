-- migrate: foreign_keys=off
-- Windows (docs/design/cross-platform-2026.md): `devices.platform` gains 'windows' (a Windows
-- desktop app, win-helper or psyche-node) and `nodes.kind` gains 'win-helper' (the Host's own
-- Windows helper, granted like 'mac-helper' only on the node transport with the handshake
-- secret). SQLite cannot alter a CHECK, so both tables are rebuilt. Other tables reference them,
-- so the runner turns foreign keys off around this file (first line) and checks them before it
-- commits: the DROPs must not run ON DELETE CASCADE / SET NULL on nodes, pairing requests,
-- passkeys, channels or threads. Columns, order, defaults and indexes are unchanged.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE devices_new (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL
    CHECK (platform IN ('macos', 'ios', 'android', 'web', 'linux', 'windows')),
  role TEXT NOT NULL CHECK (role IN ('client', 'node', 'both')),
  public_key BLOB NOT NULL,                       -- raw Ed25519 public key (32 bytes)
  token_hash BLOB,                                -- hash of the scoped device token; never the token
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  paired_at TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  device_family TEXT
);
INSERT INTO devices_new (
  id, name, platform, role, public_key, token_hash, scopes, paired_at, last_seen_at, revoked_at,
  created_at, updated_at, device_family
)
SELECT
  id, name, platform, role, public_key, token_hash, scopes, paired_at, last_seen_at, revoked_at,
  created_at, updated_at, device_family
FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;
CREATE UNIQUE INDEX devices_token_hash_idx ON devices (token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE nodes_new (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('mac-helper', 'vm-guest', 'remote', 'phone', 'win-helper')),
  capabilities TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(capabilities) AND json_type(capabilities) = 'array'),
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'degraded')),
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO nodes_new (
  id, device_id, kind, capabilities, status, last_heartbeat_at, created_at, updated_at
)
SELECT id, device_id, kind, capabilities, status, last_heartbeat_at, created_at, updated_at
FROM nodes;
DROP TABLE nodes;
ALTER TABLE nodes_new RENAME TO nodes;
CREATE INDEX nodes_device_id_idx ON nodes (device_id);
