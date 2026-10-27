---
"@psyche/protocol": minor
"@psyche/permissions": minor
"@psyche/agent-core": minor
"@psyche/connectors": minor
"@psyche/files": minor
"@psyche/sandbox": minor
"@psyche/channels": patch
"@psyche/ui": minor
---

Run commands on this Mac (`exec_host`). It is off by default. Turn it on in Settings → File access, or a chat can ask you to. Every command asks on the Mac, showing the exact command, folder, environment and program. You choose Allow once, or Always allow for exactly that command for 30 days. A turn that read untrusted content gets Allow once only.

Commands run under srt with Psyche's deny profile, and only in shared folders. Typing UNSANDBOXED on the card runs one command without the sandbox.

When a tool is missing a permission (a folder, run-commands, a connector action set to Deny, a connector, macOS access, the sandbox), the agent now asks with `request_permission` instead of giving up. `request_permission` replaces `request_folder_access`.
