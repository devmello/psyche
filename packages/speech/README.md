# @psyche/speech

**Owner:** S17 ([prompts/s17-speech.md](../../prompts/s17-speech.md)). Features Q1 (TS side), Q3, Q4 and N11 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md); architecture §5 (dictation), §4.10 (voice notes), §11 (`voice.*`); ADR-014.

Speech-to-text and text-to-speech behind the `SpeechEngine` contract, engine selection, the whisper.cpp and Kokoro engines on the Gateway host, cloud voices, the Web Speech fallback for the web client, `voice.*` dictation sessions, read-aloud, and voice-note transcoding per channel. The Mac-native engines (SpeechAnalyzer, Parakeet, WhisperKit, AVSpeechSynthesizer) live in the Swift helper (S14); this package reaches them as node capabilities.

## Public API

| Export | What it does |
| --- | --- |
| `createSpeechStack(opts)` / `createSpeechEngine(opts)` | Wires the default engines and returns `{selector, engine, transcoder, models}`; `engine` is a `SpeechEngine` that routes per call |
| `SpeechEngineSelector`, `RoutedSpeechEngine`, `DEFAULT_SPEECH_SETTINGS` | Selection policy (below); `explain()` lists each engine and why it is or is not eligible |
| `NodeSpeechEngine`, `NODE_SPEECH_CAPABILITIES` | `SpeechEngine` over the Mac helper's `speech.*` capabilities |
| `WhisperEngine`, `WhisperCliBackend`, `WhisperServerBackend` | whisper.cpp: per-request `whisper-cli`, or a loopback `whisper-server` that keeps the model loaded |
| `KokoroEngine`, `KokoroOnnxRuntime`, `PhonemizePhonemizer`, `ipaToMisaki` | Kokoro-82M on an injected `onnxruntime-node` |
| `CloudTtsEngine` | OpenAI and ElevenLabs voices; the key comes from the vault as a one-shot `ResolvedSecret` |
| `webSpeechDictation`, `WEB_SPEECH_ENTRY` | Client-side helper for psyche-web (browser owns the mic) |
| `VoiceSessionManager` | `voice.start / push / stop / cancel` and `voice.segment` / `voice.ended` events |
| `ReadAloudService` | `speech.readAloud(messageId)`: streams `speech.audio` events, saves an MP3 Library item |
| `VoiceMemoService`, `analyzeTranscript`, `looksLikeTask`, `memoTitle` | Voice memos (Q4): recorded audio → transcript → Library `recording` → optional Task, with provenance by speaker |
| `VoiceNoteTranscoder`, `transcribeVoiceNote`, `VOICE_NOTE_PROFILES`, `oggOpusToCaf` | Voice notes per channel and inbound decode → transcript |
| `ModelManager`, `MODEL_CATALOG` | Checksummed model downloads into `$PSYCHE_HOME/models/` |
| `SegmentSequencer`, `buildVocabulary`, `parseSsmlLite`, PCM helpers | Building blocks shared by the engines |
| `DictationVocabularyProvider`, `NodeContactsSource`, `agentNameFrom`, `ownerNamesFrom` | Session-default vocabulary from IDENTITY.md, USER.md, contacts and topics (below) |
| `VoiceCatalog` | Every synthesis voice as `<engine>:<voice>` for persona voice selection (Q3); `isNonCommercial(ref)` for the Personal Voice caveat |
| `createSpeechHandlers`, `SPEECH_METHODS` | `voice.*`, `voice.memo.save`, `speech.readAloud`, `speech.voices` handlers for the Gateway, typed against the protocol |
| `DecodingSpeechEngine`, `channelVoiceTranscoder` | Glue for channels: compressed inbound notes decode before the engine; the encoder behind the channel package's transcoder port |

## Read-aloud and Personal Voice (Q3)

Q3 is done when "a message can be played and saved as a file". `speech.readAloud {messageId, voice?}` (`createSpeechHandlers`) answers `{streamId}` at once; `ReadAloudService` streams the synthesized PCM to the requesting device as ordered `speech.audio` events (`last: true` on the final chunk) so playback starts with the first sentence, then encodes MP3 (44.1 kHz mono, the Library profile), saves it as a Library `audio` item tagged `read-aloud` and `message:<id>`, and announces it with `speech.readAloud.completed`. `test/q3.test.ts` checks this end to end with real ffmpeg: the events reassemble to the exact PCM, ffprobe reads the saved file as MP3 of the same length, and it decodes back.

- **Voice per persona.** Without a `voice` in the request, read-aloud uses `personaVoice()` (IDENTITY.md `voice:`), then `speech.tts.voice`. `speech.voices` lists the choices.
- **Personal Voice is opt-in.** `NodeSpeechEngine` looks a voice id up in the helper's `speech.voices` (cached; an unknown id triggers one refresh). A Personal Voice is refused with `policy_denied` before the helper is called unless the owner setting (`createSpeechStack({personalVoice})`, `speech.tts.personalVoice`) is on; when it is, the call carries the helper's required `personalVoice: true`.
- **Non-commercial caveat.** With `nonCommercial: (ref) => catalog.isNonCommercial(ref)`, a clip read by a Personal Voice is tagged `non-commercial` in the Library (Apple's terms limit that output to personal use); a failing check tags it too.

## Voice conversation (Q5, docs/voice/voice-mode-2026.md)

`VoiceConversationManager` (in `src/conversation/`) runs the Gateway-owned voice conversation behind the `voice.conversation.*` methods of `createSpeechHandlers`. There is one conversation per device, and its events go to that device only.

- **Turns.**
  - Push-to-talk turns run from `turn begin` to `turn end`.
  - Tap and hands-free turns end after a 600 ms pause (`PcmVad`, energy on 30 ms frames), or 1.2 s when the transcript so far ends in a trailing word ("and", "so", "um"…).
  - Under 300 ms of speech is ignored. Each turn is seeded with 600 ms of pre-roll.
  - Transcription uses the dictation engine and the session vocabulary.
- **The reply.**
  - The owner's words go to `VoiceTurnPort.send`, the Gateway's chat path, with `StartTurnInput.voice`.
  - `SpokenText` turns the streamed deltas into sentences as each completes. `brief` keeps the lead up to the first blank line or about 60 words; `full` keeps up to 2 000 characters. Code, table rows and raw URLs are skipped, and "The rest is on screen." closes a cut answer.
  - Each sentence is synthesized as soon as it is complete and streamed as `voice.conversation.speech`, with `last` on its final chunk.
- **What was heard.** The conversation listens again only after every utterance was reported `played … done`, plus a 600 ms echo hold.
- **Barge-in.** A client `interrupt {stage: "suspect"}` opens a tentative turn. A transcribed word that isn't in the sentence being spoken confirms it, which stops synthesis, closes that sentence's caption and keeps the owner's turn. With no such word within 1 s the reply goes on. `confirmed` (a key press) stops at once.
- **Waiting.** A run waiting for an approval or a question puts the conversation in `waiting`, with the card on screen and the mic not transcribed. Answering by voice is G3.
- **Endings.** Stop, 30 s idle (hands-free), a new start on the same device, and `endForDevice` (lock, sleep, disconnect) or `endAll` (shutdown). Every ending aborts transcription and synthesis and reports `listening: false`.

The Gateway wiring (the turn port over the chat path, the agent-core voice-turn section, the mount) is V-G's next PR.

## Voice mode (Q5)

Voice mode runs in the shell (`apps/web/src/shell/voice-mode.ts`) on top of this package's methods; nothing here is specific to it except two read-aloud options:

- `ReadAloudService.start(messageId, deviceId, {save: false})` (`speech.readAloud {save: false}`) streams the reply as `speech.audio` without encoding an MP3, saving a Library item or emitting `speech.readAloud.completed`; `done` resolves `null`.
- `ReadAloudService.cancel(streamId, deviceId)` (`speech.readAloud.cancel`) stops a running stream at once for barge-in: no further audio is sent (the held-back last chunk is dropped) and `speech.readAloud.failed` reports `cancelled`. Another device's stream id is ignored.

The loop: a dictation session per utterance (a 0.9 s pause or releasing hold-to-talk ends it), `chat.send`, the run's `run.updated` / `chat.message` events, then the last agent message read with `save: false` (or the browser's `speechSynthesis`). Talking over the reply cancels it and starts a new session fed with the last 600 ms of audio. A run waiting for an approval or an answer shows "Needs your approval on screen" and transcribes nothing; no voice path calls `approvals.*`.

## Engine selection

Transcription order (setting `speech.stt.order`, default `["mac-node", "whisper", "web-speech"]`):

1. **mac-node**: a paired, online Mac helper offering `speech.transcribe_stream` (SpeechAnalyzer / DictationTranscriber on macOS 26+; on-device SFSpeechRecognizer on macOS 15 until spike 03 picks Parakeet or WhisperKit).
2. **whisper**: whisper.cpp on the Gateway host, when `whisper-cli` and the model are present.
3. **web-speech**: only when the caller is the web client (`location: "client"`); Electron has no Web Speech backend and channels or the agent cannot use a browser engine.

Synthesis order (`speech.tts.order`, default `["kokoro", "mac-node"]`, voice `kokoro:af_heart`). A persona voice `<engine>:<voice>` (IDENTITY.md `voice:`) puts its engine first. Cloud voices (`openai`, `elevenlabs`) are registered only when a vault key resolver is configured and are used only if the owner names them in the order or as the persona voice, because they send text off the machine.

Each engine has a cheap `available()` probe (binary and model present, node online, key configured); a throwing probe counts as unavailable. `select()` rejects `unavailable` (retryable) with the reason per engine.

## Custom vocabulary (Q1, spike 03)

Spike 03 measured `DictationTranscriber` with contextual strings at 3.0–3.4 % WER against 6.5 % without them, and 4/4 on the agent's name; the helper picks that engine only when the stream carries a vocabulary. `DictationVocabularyProvider` therefore builds the session default that `VoiceSessionManager` and `VoiceMemoService` pass on every `voice.start` (and the Gateway hands to the helper as `speech.transcribe_stream.vocabulary`, to whisper.cpp as `--prompt`):

| Source | Read from | Notes |
| --- | --- | --- |
| Agent name | `IDENTITY.md` frontmatter `name:` | Always first, so the list is never empty on a configured Psyche |
| Owner name, people | `USER.md`: the `Name:` field and bullets under `## People` / `## Family` / `## Contacts` (text before the first `(`, `,`, `:` or dash) | Directives and free text are not mined |
| Custom terms | `speech.stt.vocabulary` (Settings → Voice & dictation) | |
| Contacts | a `ContactsSource`: `NodeContactsSource` asks the Mac helper for `contacts.list {limit, fields: ["name"]}` → `{contacts: [{id, name, nickname?}]}` (requested from S14; absent capability → no names) | Names and nicknames only; never numbers or addresses |
| Recent topics | an injected callback (memory or search) | newest first |

`buildVocabulary` de-duplicates, drops placeholders and markup, and caps the list at 64 terms of ≤ 48 characters; the result is cached for 60 s (`invalidate()` on `memory.file.changed` for IDENTITY.md / USER.md). Every source is best effort: an offline node or a throwing callback is skipped, never fatal.

**Voice selection per persona** (Q3): `VoiceCatalog.list({personaVoice?})` returns every voice the available synthesis engines offer, in `speech.tts.order` with the persona's engine first, as `{ref: "<engine>:<voice>", engine, location, default, nonCommercial?}`; `ref` is what IDENTITY.md `voice:` and `speech.readAloud {voice}` take, and `nonCommercial` marks an Apple Personal Voice. Cloud engines appear only when the owner listed them in the order.

## Engine matrix

Measured on an Apple M5 (16 GB, macOS 27.0.1) on 2026-10-19 unless marked otherwise.

| Engine | Where | Streaming | Latency / speed | Memory | Notes |
| --- | --- | --- | --- | --- | --- |
| SpeechAnalyzer (Mac node) | macOS 26+ helper | yes (volatile + final) | first partial ≈ 1.04 s (SpeechTranscriber) / 0.75 s (DictationTranscriber), finalize 55–115 ms (S14 bench, M5) | helper ≈ 42 MiB; models system-managed | Best default on a Mac; S14 |
| Parakeet / WhisperKit (Mac node) | macOS 14–15 helper | yes | ~0.19 s short clip (Parakeet, research KQ6) | 0.3–1.5 GB | S14 |
| whisper.cpp `tiny.en` | Gateway | chunked (partial every 1 s of speech) | 4.5 s clip in 0.48 s for two utterances (Metal, model reloaded per call) | ~273 MB | Drops speech after long pauses unless split (we split) |
| whisper.cpp `base.en` (default) | Gateway | chunked | not measured; ~2× tiny | ~388 MB | Default model id `whisper-base.en` |
| whisper.cpp `large-v3-turbo-q5_0` | Gateway | file only advised | not measured | ~1.5 GB | Use with `whisper-server` |
| Web Speech | web client | yes | browser-dependent | — | Chrome sends audio to Google; last resort |
| Kokoro-82M q8 (ONNX, CPU) | Gateway | per sentence | RTF 0.47–0.60 (6 s of audio in 2.8–3.6 s) | +110–220 MB RSS | Linux x64 not measured; expect slower |
| AVSpeechSynthesizer (Mac node) | helper | per utterance | — | — | Personal Voice has non-commercial terms |
| OpenAI / ElevenLabs | cloud | per request | network-bound | — | 24 kHz PCM requested from both |

**Streaming dictation with whisper.cpp** is VAD-gated chunked inference: a 30 ms-frame energy VAD with an adaptive noise floor finds utterances (210 ms pre-roll, 600 ms of silence ends one, 15 s cap); while an utterance grows the engine re-transcribes it every second of speech and emits a volatile partial; at its end it emits the final. Custom vocabulary and the tail of the previous final go into whisper's `--prompt`. File transcription uses the same splitter (25 s cap) because tiny/base models stop decoding after a long pause and silently drop the rest.

**Partial/final contract** (all engines, `SegmentSequencer`): finals are committed and in time order (an overlapping final is clamped to start where the previous ended); a partial is the volatile tail after the last final; repeated and empty partials are dropped; a partial still pending when the stream ends is promoted to a final, so the last thing a client sees is a final.

**Custom vocabulary** (`buildVocabulary`): agent name, owner name, the owner's custom terms, contact names, recent topics, in that order; de-duplicated, at most 64 terms of ≤ 48 characters, with placeholders and markup dropped. `voice.start` merges request terms with the session default.

## Model download policy

- Nothing downloads on its own. `ModelManager.ensure(id)` runs only when the owner picks a model (Settings → Voice & dictation, onboarding, a CLI command). Until then the engine reports unavailable and selection falls through.
- Every model is pinned in `src/catalog.ts` to an HTTPS URL and a SHA-256 (whisper.cpp: Hugging Face LFS hashes, cross-checked with the SHA-1 list in whisper.cpp `models/README.md`; Kokoro: pinned to repo commit `1939ad2`). Bytes are hashed while streaming into `<file>.part`; a size or hash mismatch deletes the partial and rejects. Only verified files are renamed into place.
- Layout: `$PSYCHE_HOME/models/whisper/ggml-<name>.bin`, `models/vad/…`, `models/kokoro/{model_quantized.onnx, tokenizer.json, voices/<id>.bin}`. Directories 0700, files 0600.
- Catalog: whisper `tiny(.en)`, `base(.en)`, `small(.en)`, `large-v3-turbo(-q5_0)`, Silero VAD v6.2.0; Kokoro q8 model, tokenizer, 28 English voices.

## Runtime dependencies (not bundled)

| Need | How | Why not bundled |
| --- | --- | --- |
| `ffmpeg`, `ffprobe` with libopus + libmp3lame | `brew install ffmpeg`, `apt install ffmpeg` (Debian trixie ships 7.1) | Static and Homebrew builds are GPL; running a separate binary is fine, shipping one is the packager's decision |
| `whisper-cli` (whisper.cpp ≥ 1.9) | `brew install whisper-cpp`, or `cmake -B build && cmake --build build` | Native; `whisper-server` is not in the Homebrew formula (build it from source for the server backend) |
| `onnxruntime-node` (MIT, ~300 MB unpacked) | installed by the Gateway and passed as `ort` | Too heavy for every consumer of this package |
| `phonemize` (MIT) | dependency of this package | Loaded with `require`: its ESM build imports JSON without import attributes, which Node 24 rejects |

`kokoro-js` and `sherpa-onnx-node` are deliberately not used: both embed espeak-ng (GPL-3.0) despite their Apache-2.0 labels, and packages may not depend on GPL code.

All binaries run through a `ProcessRunner` with an argv array and a minimal environment (`PATH`, `HOME`, `LANG`, `TMPDIR`); the Gateway can wrap it (`srt` on macOS via `prefix`, the sandbox on Linux) because inbound audio is untrusted input to a large C decoder.

## Voice-note formats

Synthesize once to PCM, then encode per channel. Caps are upload limits; when a clip would exceed one, the encoder walks down the bitrate ladder and refuses if the lowest rung does not fit.

| Channel | Container | Rate | Bitrate ladder (kbps) | Cap | Native bubble |
| --- | --- | --- | --- | --- | --- |
| Telegram (`sendVoice`) | OGG/Opus `audio/ogg` | 48 kHz mono | 48, 32, 24, 16 | 50 MB | yes |
| WhatsApp (PTT) | OGG/Opus | 48 kHz mono | 48, 32, 24, 16 | 16 MB | yes |
| Signal | OGG/Opus | 48 kHz mono | 48, 32, 24, 16 | 100 MB (unverified) | yes |
| iMessage | CAF/Opus `audio/x-caf`, `Audio Message.caf` | 48 kHz mono | 32, 24, 16 | 100 MB (unverified) | yes (see caveat) |
| Slack | MP3 `audio/mpeg` | 44.1 kHz mono | 64, 48, 32 | 1 GB | no |
| Discord | MP3 | 44.1 kHz mono | 64, 48, 32 | 10 MB (unverified) | no |
| Email | MP3 | 44.1 kHz mono | 64, 48, 32 | 18 MB (25 MB minus base64) | no |
| SMS (MMS) | MP3 | 44.1 kHz mono | 64, 48, 32 | 5 MB (unverified) | no |
| Web chat, Library | MP3 | 44.1 kHz mono | 64, 48, 32 | 50 MB | no |

**iMessage caveat.** Apple documents only "CAF" for inline voice notes; Opus inside CAF is community-reported (OpenClaw/BlueBubbles skills), and the message must also be flagged as an audio message by the sender. ffmpeg cannot write Opus (or AAC) into CAF (`cafenc.c`: "muxing codec currently unsupported"), so `oggOpusToCaf` remuxes ffmpeg's Ogg packets into CAF in-process, with the chunk layout `afconvert -f caff -d opus` produces (`desc`, `kuki`, `chan`, `pakt`, `data`). Apple's `afinfo` and `afconvert` read and decode the result on macOS 27; whether Messages renders it as a bubble must be checked end to end with the Mac node (S14/S10).

**Inbound.** `transcribeVoiceNote(engine, transcoder, file)` writes the file to a private temp dir (CAF and moov-at-end M4A cannot be decoded from a pipe), decodes to 16 kHz mono s16le with ffmpeg and transcribes with the selected engine. `createSpeechStack().engine` is wrapped in `DecodingSpeechEngine`, so the channel service's existing `transcribeFile(data, {encoding: "opus"})` call works as is; outbound, `channelVoiceTranscoder(stack.transcoder)` satisfies the channel package's `VoiceTranscoder` port (by container, or by channel to get that channel's cap and file name). Together with `VoiceNotes` in `packages/channels` that is the Telegram round trip of Q4.

## Voice memos (Q4)

`VoiceMemoService.ingest({audio, format, speaker, source, threadId, task?})` turns a recording into a Library item and, when asked, a Task:

1. **Decode.** Raw PCM and WAV are decoded in-process; Opus, MP3 and CAF go through the transcoder (ffmpeg), which also means a channel voice note is stored verbatim while a composer recording is stored as MP3 (WAV when ffmpeg is absent). Memos longer than 10 minutes are refused.
2. **Transcribe** with the routed engine and the merged vocabulary, unless the caller passes a transcript it already has: a composer memo is a dictation session started with `memo: true`, and `fromDictation(manager, sessionId, ctx)` calls `VoiceSessionManager.stopMemo`, which returns the live transcript together with the PCM the session received, so the audio is transcribed once.
3. **Classify the transcript as content.** `analyzeTranscript` lists URL-like strings (nothing fetches them) and flags instruction-like phrasing (`override`, `role_prefix`, `new_instructions`, `identity_swap`, `secrecy`, `exfiltration`, `placeholder`, `markup`). The text itself stays verbatim.
4. **Provenance follows the speaker.** The owner's own voice is `owner`; anyone else is `untrusted`, and the item, the task (`taint: true`, `taintSources: [{sourceKind: "voice_note", origin, sender}]`) and the message block say so. An owner memo that reads like instructions still produces an untainted item, but a task forced from it starts tainted.
5. **Library item**: kind `recording`, origin `upload` (composer) or `channel`, tags `voice-memo`, the source and the channel, the transcript as `textExtract`, named after the task title ("Call Alice at noon tomorrow.wav").
6. **Task** (`task: "auto" | "always" | "never"`): in `auto`, only a memo that opens with a cue ("remind me to…", "todo:", "don't forget…", "add a task…") becomes a task; it needs a thread and a `TaskEngine`. The goal is the transcript plus a pointer to the memo item; `createdFrom` is `chat` or `channel`.
7. **Blocks** for the carrying message: a text block quoting the transcript under a label (`**Voice memo, 0:05**` or `**Voice note from @sender on telegram (untrusted), 0:05**`, with a note when links or instruction-like phrasing were found), a `file` block and, if created, a `task` block.

Inbound channel voice notes (N11/Q4 round trip) reach the same path: the adapter hands the attachment bytes with `memoFormatFor(mime)` and `speaker` from its owner check, so the transcript lands in the thread with the right provenance and the audio in the Library.

## Tests and gates

`pnpm --filter @psyche/speech test` runs everything that needs no external binary. Gated suites skip themselves:

| Suite | Gate | Covers |
| --- | --- | --- |
| whisper.cpp on the fixture clip | `whisper-cli` on PATH (or `PSYCHE_WHISPER_CLI`) and a model at `PSYCHE_WHISPER_MODEL` (default `$PSYCHE_HOME/models/whisper/ggml-tiny.en.bin`) | File and streaming transcription of `test/fixtures/remind-alice.wav` |
| Transcoding matrix | `ffmpeg` and `ffprobe` with libopus and libmp3lame | 4 PCM input formats × 6 channels verified with ffprobe, decode round trip, CAF remux |
| OGG/Opus voice memo | same ffmpeg gate | `test/memo.test.ts`: the fixture encoded for Telegram, ingested as an untrusted channel memo |

`test/fixtures/remind-alice.wav` is 4.5 s of Kokoro-82M (Apache-2.0) voice `af_heart` saying "Hello Psyche. Remind me to call Alice at noon tomorrow.", 16 kHz mono. `test/fixtures/kokoro-tokenizer.json` is the Kokoro v1.0 ONNX tokenizer (Apache-2.0).

## Stubbed or open

- `voice.*` and `speech.readAloud` method/event schemas are in devmello/psyche#56 (unmerged); this package defines matching local types (`src/voice.ts`, `src/readAloud.ts`) and the Gateway (S01) wires them once it lands.
- `NodeSpeechEngine` follows the helper's capability spec in devmello/psyche#47 (`speech.transcribe_stream` with `source: "push"`, `speech.audio_push`, `speech.synthesize`, `speech.voices`), tested against a fake helper; not yet run against the real helper because #47 is unmerged.
- Moonshine is not wired: there is no maintained Node binding; `@huggingface/transformers` would work but pulls `sharp` (LGPL libvips).
- The Library writer and message reader for read-aloud are injected interfaces; no contract exists for them yet.
- M2: voice mode with barge-in (Q5), per-persona voice selection UI, diarization.

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
