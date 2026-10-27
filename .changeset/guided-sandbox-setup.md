---
"@psyche/protocol": minor
"@psyche/sandbox": minor
"@psyche/mcp-host": minor
"@psyche/gateway": minor
"@psyche/ui": minor
"@psyche/cli": patch
---

Guided sandbox setup, srt first. Stdio MCP servers run under `srt` (Seatbelt, no VM), found at each launch from `PSYCHE_SRT_PATH`, the new `exec.srtPath` setting, or PATH and the usual install folders, so installing it needs no restart. Where there is no sandbox, Settings → Connectors offers "Set up sandbox": the npm install command, Check again, choosing srt's location, and container runtimes as optional stronger isolation. The walkthrough is backed by the read-only `sandbox.setup`, and `sandbox.status` reports `srt`. Onboarding gains an optional Sandbox step.
