---
"@psyche/protocol": minor
"@psyche/model-router": patch
"@psyche/gateway": patch
---

Remove the text-to-speech surface from the protocol: `speech.readAloud*`, `speech.voices`, all `voice.conversation.*` methods and events, `speech.audio` and the read-aloud events, the helper's synthesis schemas and the `voice` model role. Dictation, voice memos and the two-key watch stay.
