-- Browser access dropped (owner decision 2026-11-25): Psyche no longer opens in a browser, and
-- `DevicePlatform` no longer has 'web'. A browser paired before this is revoked like a removed
-- device (`revokeDevice`: revoked_at set, token hash dropped), so its key can never reconnect,
-- whatever platform it would declare. The row stays for the audit trail and its references;
-- `listDevices` never returns a 'web' row, so no client decodes the old value. The CHECK keeps
-- 'web' so these rows stay valid without a table rebuild.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

UPDATE devices
SET
  revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  token_hash = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE platform = 'web' AND revoked_at IS NULL;
