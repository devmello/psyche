-- migrate: foreign_keys=off
-- Machines (docs/design/linux-helper-only-2026.md sections 4.3, 6.1, 9; wave H3): separate
-- computers the owner paired so Psyche can use their screen, apps, shell and files.
--   * `nodes.kind` gains 'machine'. SQLite cannot alter a CHECK, so `nodes` is rebuilt (the
--     runner turns foreign keys off around this file, as for 202611051300). Columns, order,
--     defaults and the index are unchanged.
--   * `machines` is the owner's stored decision: a device is a machine only while a row names it.
--     Nothing a node declares writes it; only an approved machine pairing (a `purpose: machine`
--     setup token spent by the node itself, or the owner approving a machine pairing request).
--     The table is sealed (apps/gateway/src/security/seal-spec.ts). `announced_at` only records
--     that the "added" notice went out and is not sealed.
--   * `pairing_requests.purpose` says what approving the request makes the device.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE nodes_new (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN (
      'mac-helper', 'vm-guest', 'remote', 'phone', 'win-helper', 'host-helper', 'guest', 'machine'
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

CREATE TABLE machines (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL UNIQUE REFERENCES devices (id) ON DELETE CASCADE,
  approved_at TEXT NOT NULL,
  approved_by_device_id TEXT,
  via TEXT NOT NULL CHECK (via IN ('setup_token', 'pairing_card')),
  announced_at TEXT
);

ALTER TABLE pairing_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'device'
  CHECK (purpose IN ('device', 'machine'));
