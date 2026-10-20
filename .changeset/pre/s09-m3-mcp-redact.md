---
"@psyche/mcp-host": minor
"@psyche/gateway": patch
---

MCP results pass through the vault redactor; removing a server clears its sandbox volume and egress allowlist (`StdioLauncher.forget`, `egressRevoke`); docs/05 §11 states the origin-bound bearer exception (#284).
