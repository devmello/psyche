-- Security state integrity (docs/design/security-state-integrity-2026.md; security §2, §10).
--
-- security_seal / security_ledger: the sealed copy of the security tables. Only the Gateway's
-- own connection maintains them (TEMP triggers keyed with a secret outside this database), so a
-- write from any other connection leaves them behind and is undone at the next check.
CREATE TABLE security_seal (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  format INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  -- HMAC(K, "agg-init" || key_id) XOR HMAC(K, "agg" || mac) over every ledger entry, hex.
  agg TEXT NOT NULL,
  -- 'sealed', or 'untrusted:<reason>' until the owner re-seals.
  state TEXT NOT NULL DEFAULT 'sealed',
  -- Bumped by every ledger change: a lower value than the Gateway saw is a rollback.
  gen INTEGER NOT NULL DEFAULT 0,
  sealed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- HMAC(K, format || key_id || agg || gen || state): the row cannot be edited without K.
  mac TEXT NOT NULL DEFAULT ''
);

CREATE TABLE security_ledger (
  tbl TEXT NOT NULL,
  pk TEXT NOT NULL,
  -- Canonical JSON of the sealed columns.
  row TEXT NOT NULL,
  -- HMAC(K, tbl || pk || row), hex.
  mac TEXT NOT NULL,
  PRIMARY KEY (tbl, pk)
) WITHOUT ROWID;

-- The inbox for `psyched` commands on the machine. Anything running as the owner can write it,
-- so nothing here is trusted: the Gateway decides what each request becomes.
CREATE TABLE security_requests (
  id TEXT PRIMARY KEY NOT NULL,
  op TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params)),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'applied', 'waiting', 'refused')),
  outcome TEXT,
  recovery_id TEXT,
  not_before TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX security_requests_status_idx ON security_requests (status, created_at);

-- Sealed: local recovery requests that apply after a delay unless cancelled.
CREATE TABLE security_recoveries (
  id TEXT PRIMARY KEY NOT NULL,
  op TEXT NOT NULL,
  params TEXT NOT NULL CHECK (json_valid(params)),
  status TEXT NOT NULL CHECK (status IN ('waiting', 'applied', 'cancelled', 'failed')),
  -- When this Gateway first saw the request, on its own clock.
  seen_at TEXT NOT NULL,
  not_before TEXT NOT NULL,
  decided_at TEXT,
  decided_by_device_id TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX security_recoveries_status_idx ON security_recoveries (status, not_before);

-- Sealed: what the owner is shown until an admin acknowledges it.
CREATE TABLE security_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'info')),
  details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details) AND json_type(details) = 'object'),
  created_at TEXT NOT NULL,
  notified_at TEXT,
  acknowledged_at TEXT,
  acknowledged_by_device_id TEXT
);
CREATE INDEX security_alerts_open_idx ON security_alerts (acknowledged_at, created_at);
