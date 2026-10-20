---
"@psyche/model-router": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

Subscription CLIs as model providers: `claude-code/<model>` (Claude Code headless, the owner's Claude plan) and `codex/<model>` (Codex `exec --json`, the owner's ChatGPT plan), with Psyche's tools bridged over a stdio MCP relay so the agent loop and Permission Broker still run every tool, session resume per turn, and a probe for installed / signed in that reports no account details. Listed by default in Settings → Model & providers as subscription providers.
