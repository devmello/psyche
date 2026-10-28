---
"@psyche/permissions": minor
"@psyche/ui": minor
"@psyche/gateway": minor
---

Approval cards: one control set (the scope is a selector on Allow, then Deny / Allow), a plain-language taint sentence instead of raw "Taint sources" (raw ids under Details), and the reason shown once. The folder card pre-fills the folder the agent asked for, resolved by the Gateway (real path, must exist and be a folder; sensitive roots are blocked and fall back to the picker), with "Choose a different folder…" as an optional override.
