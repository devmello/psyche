---
"@psyche/protocol": minor
"@psyche/sandbox": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

"Install with Psyche" in the sandbox walkthrough and onboarding. After a click and a confirm that names `@anthropic-ai/sandbox-runtime` 0.0.81 and the folder, the Gateway installs srt itself with its bundled Node (which ships without npm): it fetches the pinned tarballs from registry.npmjs.org, checks each against its pinned sha512 integrity (fail closed), unpacks them into `$PSYCHE_HOME/tools/srt/<version>/` (0700, no scripts, no global prefix, no sudo) with a `bin/srt` launcher, saves `exec.srtPath` and logs a receipt. New `sandbox.installSrt` (operator.admin, fresh presence); `sandbox.setup` reports the pinned and installed versions. Reinstall for a broken path, Update when a newer Psyche pins another version.
