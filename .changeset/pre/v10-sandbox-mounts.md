---
"@psyche/sandbox": minor
"@psyche/gateway": patch
---

The container runner bind-mounts validated host folders (`ensureSandbox(scope, {mounts})`, V10 coding workspaces); the Gateway protects `$PSYCHE_HOME` from mounts and exposes the sandbox part's egress context tracker.
