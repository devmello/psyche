---
"@psyche/sandbox": minor
---

`ContainerSandboxRunner.openStdio(sandboxId, { argv, cwd, env })`: a long-lived sandboxed process with raw stdin / stdout / stderr pipes for stdio MCP servers (#143). Env is delivered inside the container, the process keeps the container busy, `kill` and runner shutdown stop its process group, and its output is untrusted.
