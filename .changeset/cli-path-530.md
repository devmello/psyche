---
"@psyche/model-router": patch
"@psyche/cli": patch
"@psyche/desktop": patch
---

Subscription CLIs are found under launchd (#530): `claude` and `codex` resolve from PSYCHE_CLAUDE_PATH / PSYCHE_CODEX_PATH, PATH, Homebrew and user install directories, and the login shell; the probe shows the resolved path; the LaunchAgent plist sets a PATH with Homebrew first.
