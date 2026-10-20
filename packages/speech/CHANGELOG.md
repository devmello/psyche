# @psyche/speech

## 0.3.0-alpha.0

### Minor Changes

- 93d9add: Q3: Personal Voice is opt-in (`createSpeechStack({personalVoice})`; the node engine sends the helper's `personalVoice: true` and refuses otherwise), read-aloud uses the persona's voice and tags Personal Voice clips `non-commercial`, and `createSpeechHandlers` exposes `voice.*`, `voice.memo.save`, `speech.readAloud` and `speech.voices` to the Gateway.
- e01052d: Dictation vocabulary from IDENTITY.md, USER.md, contacts and topics (`DictationVocabularyProvider`, `NodeContactsSource`), a `VoiceCatalog` listing `<engine>:<voice>` refs for persona voice selection, and channel glue (`DecodingSpeechEngine`, `channelVoiceTranscoder`) for the voice-note round trip.
- 9cc53ce: Voice memos (Q4/N11): `VoiceMemoService` turns recorded audio into a transcript, a Library `recording` item and an optional Task, with provenance by speaker and URLs or instruction-like content kept as quoted data; dictation sessions can be started with `memo: true` and filed with `stopMemo`.
- 39dc17d: Speech engines (Mac node, whisper.cpp, Kokoro, cloud voices, Web Speech helper), engine selection, voice.* dictation sessions, read-aloud and per-channel voice-note transcoding.

### Patch Changes

- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [493b4a5]
- Updated dependencies [eaf91c6]
- Updated dependencies [19c1ba5]
- Updated dependencies [4f74993]
- Updated dependencies [5e605af]
- Updated dependencies [8a8dacb]
- Updated dependencies [6665567]
- Updated dependencies [310ac67]
- Updated dependencies [2f63bac]
- Updated dependencies [dc190a6]
- Updated dependencies [5d2cbeb]
- Updated dependencies [0899f3b]
- Updated dependencies [08664c3]
- Updated dependencies [e54d672]
- Updated dependencies [3461262]
- Updated dependencies [8a9ee2c]
- Updated dependencies [f80b0ec]
- Updated dependencies [75a0f80]
- Updated dependencies [2e9c025]
- Updated dependencies [e4c109b]
- Updated dependencies [5dcf208]
- Updated dependencies [c840e75]
- Updated dependencies [2607fc3]
- Updated dependencies [4bc7113]
- Updated dependencies [515b904]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [2b2e906]
- Updated dependencies [13afc8a]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [0c71158]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
