---
"@psyche/desktop": patch
---

The Mac helper no longer synthesizes speech: `speech.synthesize`, `speech.prepare`, `speech.voices` and `speech.personal_voice.authorize` are gone, and `speech.status` no longer reports Personal Voice or `synthesisFirstAudioMs`. Speech-to-text is unchanged (part of #692).
