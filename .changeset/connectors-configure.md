---
"@psyche/connectors": minor
"@psyche/gateway": minor
---

`connectors.configure` (#727): merges non-secret settings into a connector's config without reconnecting (`null` removes a key; secret-looking keys must be `{{cred:slug}}` placeholders; keys the Gateway manages are refused) and re-creates the live instance. Shortcuts honour `config.shortcutRules[id]` (off refuses before any card, ask asks, allow runs as a write with a receipt; a matrix deny still wins). Obsidian re-checks `vaultPath` and keeps the daily note in `config.dailyFolder`. Apple Mail attachments staged by the helper are imported into the Library (quarantined, `origin: connector`) and the staging path never reaches the model. The Gateway now gives connectors a default Library sink.
