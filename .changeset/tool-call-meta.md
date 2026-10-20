---
"@psyche/protocol": minor
---

`ToolCallDescription` and `ToolCallIntent` gain an optional `meta: ToolCallMeta {app?, action?}`, so the Permission Broker's per-app tier check can key on the computer-use action instead of the tool name.
