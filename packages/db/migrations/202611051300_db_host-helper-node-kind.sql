-- migrate: foreign_keys=off
-- Linux (docs/design/linux-desktop-2026.md section 4.3): `nodes.kind` gains 'host-helper' (the
-- Host's own helper on Linux; stored Mac and Windows rows keep 'mac-helper' / 'win-helper') and
-- 'guest' (the helper inside a separate desktop), the two kinds the protocol already names.
-- SQLite cannot alter a CHECK, so `nodes` is rebuilt. Channels reference it, so the runner turns
-- foreign keys off around this file (first line) and checks them before it commits: the DROP
-- must not run ON DELETE CASCADE / SET NULL. Columns, order, defaults and the index are
-- unchanged.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE nodes_new (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN (
      'mac-helper', 'vm-guest', 'remote', 'phone', 'win-helper', 'host-helper', 'guest'
    )),
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
