---
"@psyche/speech": minor
"@psyche/gateway": patch
"@psyche/scheduler": patch
"@psyche/proactive": patch
---

Listen on the spoken brief and check-ins: briefings, heartbeat and goal check-ins carry a `listen` action, and `voice.conversation.start {listen}` speaks the notification (capped at about 90 s), then hands over to the owner (#691).
