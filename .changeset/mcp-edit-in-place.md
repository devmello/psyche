---
"@psyche/protocol": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

Edit an MCP server in place and test an approved one. `mcp.update {id, changes}` (admin, side-effecting) applies a new display name at once; a changed command, argument, URL, auth, allowed domain, env name or secret is probed and opens the same device-only trust card as `mcp.probe`, showing old and new, and takes effect through `mcp.add` once approved while the old server keeps running. `mcp.test {id}` (admin) lists the tools of the stored config without changing it or raising a card. `mcp.config {serverId}` (admin) prefills the edit form. Settings gets Edit and Test connection on each server.
