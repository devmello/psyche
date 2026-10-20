---
"@psyche/gateway": minor
---

psyched relays approval cards to a connected Mac helper as notifications with Approve / Deny and turns the helper's answers into broker answers on the `notification` surface. Approvals that require authentication verify a Secure Enclave signature over the presence challenge against the helper's registered key; the helper does not sign yet (#84), so they stay refused there. Deny always works.
