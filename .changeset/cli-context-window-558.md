---
"@psyche/model-router": patch
"@psyche/gateway": patch
"@psyche/ui": patch
---

Context windows for the subscription CLIs (#558): Claude Code models report 200k (1M for `[1m]` variants) and Codex 272k, so `models.list`, Settings and the chat's context meter agree; when a window is unknown, Settings shows the 128k the chat assumes.
