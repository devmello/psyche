---
"@psyche/protocol": minor
"@psyche/gateway": patch
"@psyche/ui": patch
---

MCP servers from an exact official source (`@modelcontextprotocol/server-*`, listed vendor packages and vendor endpoints) are `verified` instead of `unverified`. The Gateway derives the tier (`mcpTrustFor`) when a server is added and each time `mcp.servers` is read; owner-edited commands stay `unknown`.
