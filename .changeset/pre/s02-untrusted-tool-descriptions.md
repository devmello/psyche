---
"@psyche/agent-core": minor
---

Tools whose spec says `descriptionProvenance: "untrusted"` (MCP servers that are not bundled) taint the turn they are offered in, one `tool_description` source per server, and the system prompt's tools section marks them and frames their descriptions as data, not instructions (#281).
