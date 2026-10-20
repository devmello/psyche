---
"@psyche/protocol": minor
"@psyche/gateway": minor
---

Security settings need fresh presence once a presence verifier exists (security §10): `settings.set` on a security key returns `approval_required` with a device-only, presence-gated `policy_change` card, and goes through when retried with the approved `approvalId`.
