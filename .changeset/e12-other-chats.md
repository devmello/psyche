---
"@psyche/agent-core": minor
"@psyche/gateway": minor
"@psyche/ui": minor
---

E12 "From your other chats": turn context providers in the loop; the Gateway keeps digests of the owner's chats and, with `threads.otherChats` on, brings matching ones into a turn as untrusted context with a `related_threads` block in the reply (audited); `thread_read` asks on its first read of each chat.
