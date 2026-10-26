---
"@psyche/permissions": minor
"@psyche/proactive": minor
"@psyche/db": minor
"@psyche/gateway": minor
---

Batch approvals (#670 W2): `broker.requestBatch` decides every call of a proposal, refuses anything above `write`, sends and device-only kinds, and issues one once-only `batch` card bound to the ordered calls; approving mints one approved child approval per call. `ProposalService` runs the broker's stored calls under those children with per-call results and a 30-second undo; `proposals.*` handlers and `proposal.updated` events; the `action_proposals` table.
