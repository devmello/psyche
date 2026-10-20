---
"@psyche/mcp-host": minor
---

M3: `containerLauncher` runs each stdio MCP server in its own sandbox container through the runner and speaks MCP over its pipes (`PipeTransport`); `StdioLauncher` gains `open` beside `prepare`, and launch specs carry the server's own env as `serverEnv`.
