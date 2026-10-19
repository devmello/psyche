# @psyche/audit

**Owner:** S05 (`prompts/s05-permissions-audit.md`). Feature ids: U3 and the audit side of F1–F12 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Hash-chained append-only audit log, the receipts store, strict canonical JSON and the redaction every log line passes through. Implements the `AuditLog` contract and passes `describeAuditLogConformance` (memory and file stores).

## Public API

- `createAuditLog({ dir | store, clock, redact, signer, verifier, anchorEvery, validateKinds })` → `HashChainAuditLog`: `append`, `list` (contract), `query({ kind, kinds, kindPrefix, actorType, deviceId, runId, subject, since, until, sinceSeq, untilSeq, limit, order })`, `export({ format: "jsonl" | "json", ...query })`, `verify()` (contract) and `verifyDetailed()` (adds `unparsable`, `truncated`, `anchor_mismatch`, `anchor_signature` with file and line), `subscribe`.
- Stores: `FileAuditStore(dir)` writes `audit/YYYY-MM.jsonl` (directory 0700, files 0600, fsync per line), `MemoryAuditStore`. The chain continues across months; a torn last line is left for `verify` to report and the next entry starts on its own line; `ts` never runs backwards.
- Anchors: with an `AnchorSigner` (the mac helper's key, or the server's device key) every 1,000 entries an anchor `{seq, hash, signature}` goes to `audit/anchors.jsonl`, so tail truncation is detectable (security §15.1).
- `Receipts` with `MemoryReceiptStore` / `SqliteReceiptStore`: `record` (payload redacted, `receipt.recorded` audited), `list({ taskId, toolCallId, approvalId, kind, outcome })`, `reconcile(id, { outcome, note })` for `uncertain` receipts only.
- `canonicalJSON`, `sha256`, `hashCanonical`, `CanonicalizationError`: RFC 8785 serialization over a strict value domain (throws on NaN, ±Infinity, -0, Map / Set / Date / Buffer / class instances, BigInt, `undefined` in arrays, lone surrogates; strings are not NFC-folded), S23 design-13.
- `redactForAudit(value, { redact, keep, maxStringLength })`: secret keys → `[redacted]`; content keys (`body`, `text`, `html`, `stdout`, `params`, …) → `{redacted: "content", sha256, bytes}`; every string through the secret / card / IBAN / SSN detectors and the vault's own `redact`.
- `findSensitive`, `containsSensitive`, `redactSensitive`, `luhnValid`, `ibanValid`, `cardDigits`.
- `AUDIT_KINDS`: data model §5 event names plus the broker's (`approval.invalidated`, `approval.answer_rejected`, `binding.verified`, `binding.mismatch`, `classifier.labeled`, `classifier.circuit_open`, `receipt.recorded`, `receipt.reconciled`).

## Entry format

```json
{"seq":0,"ts":"2026-10-18T20:00:00.000Z","kind":"approval.decided","actor":{"type":"device","deviceId":"dev_mac","surface":"desktop","scope":"operator.approvals"},"subject":{"approvalId":"apr_…"},"data":{"decision":"allow","grantScope":"once","bindingHash":"sha256:…","taint":false,"latencyMs":48211},"prev":"sha256:000…","hash":"sha256:…"}
```

`hash = "sha256:" + hex(sha256(canonicalJSON(entry without hash)))`; `prev` is the previous entry's hash, `AUDIT_GENESIS_HASH` first. Redaction runs before hashing, so the chain never commits to a secret or a body.

## How this maps to the docs

Architecture §4.12; data model §5 (receipts table in `packages/db/migrations/202610200900_permissions_init.sql`, event names); security §14 (file modes, retention), §15.1–§15.2.

## What is stubbed

- Signing anchors needs the mac helper (S14) or the server device key; tests use an HMAC-style stand-in.
- `psyche audit verify` / export CLI wiring is S22's; it calls `verifyDetailed` and `export`.
