-- S09 connectors (data model §8 `connectors`). Owner of the table: @psyche/connectors
-- (`SqliteConnectorStore`); drizzle mirror in src/schema-connectors.ts. Records hold no secrets:
-- tokens are connector-owned vault items, config values that are secret are `{{cred:slug}}`
-- placeholders. IF NOT EXISTS, like the other package-owned tables.
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  account TEXT,
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes)),
  scope_mode TEXT NOT NULL CHECK (scope_mode IN ('read', 'read_act')),
  action_matrix TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(action_matrix)),
  credential_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected', 'error', 'needs_auth')),
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  last_sync TEXT CHECK (last_sync IS NULL OR json_valid(last_sync)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS connectors_type_idx ON connectors (type);
