---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/db": minor
"@psyche/ui": minor
"@psyche/web": minor
---

Seal the security state against same-user tampering (docs/design/security-state-integrity-2026.md). Devices, presence keys, passkeys, setup tokens, grants, approvals, policy, channels and the security settings are sealed by a keyed ledger the Gateway's own connection keeps; it is checked at every start and before every authorizing read, a change made by any other process is undone (added devices revoked), and every device shows an alert (`security.state.get`, `security.alerts.acknowledge`, the `security.state.changed` event, a banner in the app, a `system` notification). A broken seal fails presence and every widening call closed. `psyched devices approve|grant`, `presence reset` and the new `security reseal` / `recovery cancel` go through the running Gateway: the first admin applies at once, anything else after 24 hours in plain view unless an admin cancels it or approves it now with fresh presence (`security.recoveries.cancel`, `security.recoveries.approve`). New migration `202611051800_gateway_security-seal`. This is tamper evidence, not protection against a program that reads Psyche's key files or controls `psyched`; see the design note's decisions D1–D7.
