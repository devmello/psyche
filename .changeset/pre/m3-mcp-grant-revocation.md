---
"@psyche/permissions": patch
"@psyche/agent-core": patch
"@psyche/mcp-host": patch
---

MCP grants made from the agent loop name their server and `tools/list` hash, so `revokeMcpGrants` revokes them on a listing change and an A→B→A change no longer revives them (#279). `describeMcpCall` uses the broker's `argsSha256` field name.
