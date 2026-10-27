---
"@psyche/protocol": minor
"@psyche/sandbox": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

Guided sandbox setup: where the Gateway has no sandbox for command servers, Settings → Connectors offers "Set up sandbox", a walkthrough backed by the new read-only `sandbox.setup` method (which runtimes are supported, installed and running; the recommended one; restart needed). Onboarding gains an optional Sandbox step. With a container runtime found at start and no `PSYCHE_SRT_PATH`, stdio MCP servers now run in sandbox containers by default.
