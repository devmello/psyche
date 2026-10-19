-- Skills (owner: S16, packages/skills). docs/04-data-model.md §10, architecture §13,
-- security §11. One row per skill the loader has seen, per source; `enabled` is the owner's
-- switch. The pins (source, commit, whole-tree hash, approval) live in
-- $PSYCHE_HOME/skills/skills.lock.json, outside the workspace the agent can write.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE skills (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('workspace', 'home', 'bundled')),
  version TEXT,
  path TEXT NOT NULL,
  hash TEXT,                                       -- sha256: whole-tree hash last seen
  trust TEXT NOT NULL CHECK (trust IN ('bundled', 'verified', 'local', 'unknown')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  installed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, name)
);
