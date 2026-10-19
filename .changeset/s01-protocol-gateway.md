---
"@psyche/protocol": minor
---

Admin settings become an allowlist (`USER_SETTING_PREFIXES`); `PairingRequest` gains the key fingerprint, transport and remote address; `devices.approve` takes an optional `code`; `threads.list` takes an optional title `query`; `chat.queue.list` / `chat.queue.remove` and `chat.queue.updated` expose the follow-up queue; a `thread.deleted` event; `AgentEvent` `tool_call` carries optional `details`.
