---
"@psyche/protocol": minor
"@psyche/mcp-host": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

A connected MCP server's detail now does something: list its tools and switch single tools off for the agent, turn the server off without removing it, see its secrets by name (set or not set) and replace them through the vault, and paste a `mcpServers` JSON config into the Add form (keys go to the vault). New methods `mcp.tools`, `mcp.tools.set`, `mcp.setEnabled`, `mcp.secrets`, `mcp.secrets.replace`; `McpServerStatus.enabled`.
