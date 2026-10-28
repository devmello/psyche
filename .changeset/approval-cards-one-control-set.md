---
"@psyche/permissions": minor
"@psyche/ui": minor
"@psyche/gateway": minor
"@psyche/agent-core": patch
---

Approval cards: one control set (the scope is a selector on Allow, then Deny / Allow), a plain-language taint sentence instead of raw "Taint sources" (raw ids under Details), and the reason shown once. The folder card pre-fills the folder the agent asked for, resolved by the Gateway (real path, must exist and be a folder; sensitive roots are blocked and fall back to the picker), with "Choose a different folder…" as an optional override.

`request_folder_access` / `request_permission` no longer run alongside read-only siblings in the same model response, so a `list_dir` of the folder just asked for waits for the owner's answer; tool descriptions and the base prompt say the call waits and returns the result in the same turn.
