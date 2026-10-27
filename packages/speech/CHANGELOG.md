# @psyche/speech

## Unreleased (pre-0.3.0)

### Minor Changes

- Voice mode (Q5): `ReadAloudService.start(…, {save: false})` streams a reply without filing it, `cancel(streamId, deviceId)` stops one device's stream for barge-in, and `createSpeechHandlers` serves `speech.readAloud.cancel`.
- `NodeSpeechEngine.transcribePath` over the helper's `speech.transcribe_file` (≤ 4 h, `speech.progress`), and `VoiceMemoService.ingestMeeting`: the meeting path with no 10-minute cap, the transcript as the Library item's text extract, and `untrusted` provenance unless the owner is the only speaker (#673).
- Voice conversation (V-G G1, #691): `VoiceConversationManager` with push, tap and hands-free turns, VAD endpointing with a trailing-word wait, sentence-by-sentence speech while the reply streams, `played` tracking, barge-in confirmed by a new word, waiting for approvals, and every ending path; served by `createSpeechHandlers` as `voice.conversation.*`.
- Voice turns (V-G G2, #691): the Gateway mounts the voice conversation over the chat path (spoken messages stored with `via: "voice"`, off until Settings turns it on), agent-core adds the voice-turn prompt section and the `voice` model role, tool steps are narrated from fixed labels, and `messages.via` is stored.
- Approvals by voice (V-G G3, #691): within chat's tiers (writes by default, never device-only or Touch ID approvals, deny-only in tainted turns), Psyche reads the broker's summary back, listens for a fixed phrase for 10 s and answers through the broker as the device's own card with scope `once`; the audit entry records `via: "voice"`.
- Remove the OpenAI cloud voice (`gpt-4o-mini-tts`; OpenAI's TTS endpoints shut down on 2027-01-06). An owner who picked it moves to the default voice once, with a notice (#691).
- Remove all text-to-speech from the Gateway side: synthesis in `@psyche/speech` (Kokoro, ElevenLabs, read-aloud, voice catalog, the voice conversation manager), the voice-turn prompt section and `StartTurnInput.voice`, channel voice-note sending, and the synthesis half of the `SpeechEngine` contract. Speech to text is unchanged. The Gateway removes the stale voice and synthesis settings on start (`deleteSettings` in `@psyche/db`).

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
