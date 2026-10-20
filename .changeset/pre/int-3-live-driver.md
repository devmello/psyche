---
"@psyche/testing": patch
---

Scenario `Stack` records every tool call's arguments through a `before_tool_call` hook, so a live model's parked call can be replayed after a restart (its details only arrive with the call's final event). Scripted mode is unchanged.
