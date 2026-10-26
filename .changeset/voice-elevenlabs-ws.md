---
"@psyche/speech": minor
---

ElevenLabs speaks over its input-streaming WebSocket (`stream-input`, `auto_mode`) by default, for 100–150 ms to first audio; the key goes in the first message, and abort closes the socket (#691).
