---
"@psyche/permissions": patch
---

Write+ tools of unknown-tier MCP servers ask (`mcp:unknown_tier`, `once` only) for `connector_action` calls too, which is how MCP calls arrive; an `mcp__` tool without a tier counts as unknown (#280).
