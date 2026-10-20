---
"@psyche/agent-core": patch
"@psyche/permissions": patch
"@psyche/gateway": patch
---

The broker's per-app computer-use tier check keys on the described action: the loop passes `ToolCallDescription.meta` to the broker, and `computer.act`, `apps.open` and `apps.focus` name their action, so a `click` tier (and the terminal/IDE click cap) lets the agent click but not type. A `meta.app` that differs from the app target is denied.
