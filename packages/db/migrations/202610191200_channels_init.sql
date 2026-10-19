-- §8 Channels and identities (owner: packages/channels, S10). pairing_requests (§1) already exists.

CREATE TABLE channels (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL
    CHECK (type IN ('webchat', 'telegram', 'imessage', 'whatsapp', 'signal', 'slack', 'discord', 'email', 'sms')),
  account TEXT NOT NULL,
  dm_policy TEXT NOT NULL DEFAULT 'pairing'
    CHECK (dm_policy IN ('pairing', 'allowlist', 'open', 'disabled')),
  allow_from TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allow_from)),
  group_allow_from TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(group_allow_from)),
  require_mention INTEGER NOT NULL DEFAULT 1 CHECK (require_mention IN (0, 1)),
  owner_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(owner_ids)),
  dm_scope TEXT NOT NULL DEFAULT 'per-channel-peer'
    CHECK (dm_scope IN ('main', 'per-peer', 'per-channel-peer')),
  node_id TEXT REFERENCES nodes (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error', 'disconnected')),
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (type, account)
);

CREATE TABLE identities (
  id TEXT PRIMARY KEY NOT NULL,
  display TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links)),
  delegated_persona TEXT,
  tool_allow TEXT CHECK (tool_allow IS NULL OR json_valid(tool_allow)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
