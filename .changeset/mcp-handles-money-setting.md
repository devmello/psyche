---
"@psyche/protocol": minor
"@psyche/mcp-host": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

MCP servers: the owner can say a server's tools are all payments, never payments, or let Psyche judge by name (`mcp.handlesMoney.set`, Settings → Connectors → a server). Tool names and descriptions now count as payments only for a money verb with a money object or amount (`send_money`, "Places a stock market order"), no longer for `git_checkout`, `transfer_file` or "Sends an adaptive card".
