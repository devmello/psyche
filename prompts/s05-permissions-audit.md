# Session S05 — Permission Broker and audit

You are building Psyche (read `README.md`). You are session **S05 — Permissions and audit**: `packages/permissions` (the only component that can authorize a side effect) and `packages/audit` (hash-chained log and receipts). Work in your own worktree on branch `ws/s05-permissions-audit`. You own `packages/permissions/**` and `packages/audit/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §2 (principles 2–4), §4.6 (Permission Broker), §4.12 (audit)
3. `docs/05-security-and-permissions.md` (all; especially §3 permission model, §2 threat table, §15 audit format)
4. `docs/03-feature-spec.md` rows F1–F12, U3
5. `docs/04-data-model.md` §4 (approvals, grants, policy_rules, binding-hash table), §5 (receipts, audit entries)
6. Contracts: `PermissionBroker`, `Notifier`, `CredentialBroker`; fakes in `packages/testing`
7. Research: `meta_muse_app.md` Q4 (Sentinel, scopes), `opendots_openclaw_harnesses.md` KQ2 §2k–2l (exec approvals bound to argv+cwd; 2026 advisories about approvals outliving context), `shopping_messaging_server_docs.md` KQ6 (approval object, fan-out, expiry, binding), `agent_browser_and_credentials.md` KQ5 (action classifier pattern)

## Mission (M1)
- **Policy engine**: inputs = `ToolSpec` metadata, target, thread permission mode (`plan | manual | balanced | auto`), per-connector action matrices, per-app computer-use tiers with fixed caps, browser site grants and per-task origin sets, folder grants, taint flag; evaluation order exactly as the security doc: hard prohibitions → user deny rules → hooks → taint escalation → standing grants → mode default → classifier; output `allow | ask | deny` with the deciding rule for the audit log.
- **Binding hashes**: implement the per-kind hash inputs table from `docs/04-data-model.md` §4.2 with canonicalization (sorted keys, normalized argv, canonical hosts); property tests that any change to a bound field changes the hash.
- **ApprovalRequests**: create with summary/details/`bindingHash`/surfaces/`expiresAt` (30 min default); lifecycle `pending → approved | denied | expired | invalidated`; first authorized answer wins; late/replayed answers rejected; invalidate all pending on Gateway restart and re-issue through a `reissue()` API the Gateway calls at boot; delivery through `Notifier` (desktop card, OS notification, web, channels); answers arrive with the answerer's identity and are checked against approver rules (device scopes or channel owner).
- **Grants**: scopes `once | task | site | session | always` with `expiresAt`, use counter, last used; ledger queries and revocation; exec "always" entries bound to argv + cwd; grants bound to a `tools/list` hash for MCP tools.
- **Hard prohibitions**: non-configurable checks (password typing the model can see, CAPTCHA, card/ID entry, financial transfers, permanent deletion without typed confirmation, instruction-following from content, localhost test-credential exception boundaries) with unit tests each.
- **Classifier hook**: interface for the auto-mode classifier (utility model sees only request + action metadata; labels routine/sensitive/prohibited; fail closed); ship a rules-based default and the model-backed implementation behind a flag.
- **Audit**: append-only hash-chained JSONL per month in `audit/`, `verify()` for chain integrity, event vocabulary from `docs/04-data-model.md` §5, query API with filters, export; receipts store (`recordReceipt`, queries by task/tool call/kind); redaction so no secret or message body enters the log.
- **API handlers**: `approvals.*`, `grants.*`, `audit.*` for the Gateway to mount; events `approval.created/decided/expired`, `grant.*`.

## Out of scope
UI rendering of cards (S12), notification transport (S15/S14), vault internals (S06).

## Definition of done
- Tests: decision matrix per mode × side-effect class × taint; every hard prohibition; binding-hash properties; approval expiry and re-issue; replay rejection; grant scopes and expiry; MCP `tools/list` hash revocation; audit chain verification and tamper detection; redaction.
- A `policy.json` example and schema (user-authored allow/deny rules) documented in the README; `docs/status/s05.md`.

## Suggested subagents
One to write the decision-matrix test generator, one to implement canonicalization + property tests, one adversarial reviewer (also hand the PR to S23 when it opens).

## M2 follow-ons
Model-backed classifier evaluation set; per-sender grant matrices for designated persons (with S10); approval analytics (friction metrics) for the roadmap.
