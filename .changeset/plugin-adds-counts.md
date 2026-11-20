---
"@psyche/protocol": patch
---

`PluginSummary` gains an optional `adds` (counts of skills, commands, MCP servers and hooks); the Gateway counts them from the plugin's files, not its manifest.
