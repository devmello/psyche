---
"@psyche/agent-core": patch
---

The loop freezes a call's arguments at the gate (structuredClone before hashing), recomputes the binding from the live arguments before `verifyBinding` and again immediately before dispatch, and denies with `binding_mismatch` when they changed; executors, hooks and records get copies of the gated arguments (#70).
