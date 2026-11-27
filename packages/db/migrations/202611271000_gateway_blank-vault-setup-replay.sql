-- Earlier Gateways stored the whole vault.setup result, recovery key included, for idempotent
-- replay. The key is kept sealed in the vault now (vault.recoveryKey), so blank it in old rows.
UPDATE gateway_idempotency
SET result = json_set(result, '$.recoveryKey', '')
WHERE method = 'vault.setup' AND json_extract(result, '$.recoveryKey') IS NOT NULL;
