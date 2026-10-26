---
"@psyche/speech": minor
"@psyche/channels": minor
"@psyche/agent-core": minor
"@psyche/gateway": minor
"@psyche/protocol": patch
"@psyche/testing": patch
"@psyche/db": minor
---

Remove all text-to-speech from the Gateway side: synthesis in `@psyche/speech` (Kokoro, ElevenLabs, read-aloud, voice catalog, the voice conversation manager), the voice-turn prompt section and `StartTurnInput.voice`, channel voice-note sending, and the synthesis half of the `SpeechEngine` contract. Speech to text is unchanged. The Gateway removes the stale voice and synthesis settings on start (`deleteSettings` in `@psyche/db`).
