# Session S17 — Speech and voice notes

You are building Psyche (read `README.md`). You are session **S17 — Speech**: `packages/speech`, the TypeScript abstractions for speech-to-text and text-to-speech, the server-side engines (whisper.cpp, Kokoro), the browser fallback, and the voice-note transcoding pipeline. Mac-native engines live in the Swift helper (S14) and are reached as node capabilities. Work in your own worktree on branch `ws/s17-speech`. You own `packages/speech/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §5 (dictation), §4.10 (voice notes across channels)
3. `docs/03-feature-spec.md` rows Q1–Q4, N11
4. `docs/07-tech-decisions.md` ADR-014
5. Contracts: `SpeechEngine`, `NodeClient`; fakes
6. Research: `macos_vm_and_integration.md` KQ6 (SpeechAnalyzer, FluidAudio Parakeet, WhisperKit, whisper.cpp model sizes, Moonshine; TTS options; voice-note formats per channel) and `shopping_messaging_server_docs.md` KQ2 (Telegram/WhatsApp/iMessage audio requirements)

## Mission (M1)
- **`SpeechEngine` abstraction**: `transcribeStream(audioChunks, {language, vocabulary}) → partial/final events`, `transcribeFile`, `synthesize(text, voice) → PCM`, engine capability reporting; engine selection policy (Mac node engine when available → whisper.cpp on the Gateway host → Web Speech in the web client) configurable in settings.
- **whisper.cpp engine** (server/Linux path): `whisper-cli`/server binding or a Node addon (verify maintenance), model download manager with checksums to `$PSYCHE_HOME/models/`, streaming via chunked inference, VAD; Moonshine as an optional low-latency engine if a maintained binding exists.
- **Kokoro TTS** (local): ONNX runtime path on Linux and Apple Silicon (document memory and real-time factor), voice list, SSML-lite controls; cloud voices (OpenAI, ElevenLabs) behind vault keys.
- **Voice-note pipeline** (N11): PCM → 48 kHz mono OGG/Opus (ffmpeg or a WASM encoder; prefer a bundled static ffmpeg under `srt` on macOS and the sandbox on Linux), MP3 for Slack/Discord/email, CAF container for iMessage (document the community-reported Opus-in-CAF caveat and test with the Mac node), size limits per channel (Telegram 50 MB, WhatsApp 16 MB), inbound voice-note decode → transcription.
- **Composer dictation protocol**: `voice.*` Gateway methods (start/stop stream, partials, finalize) that the desktop and web clients call; custom vocabulary from the agent name, contacts and recent topics.
- **Read-aloud**: `speech.readAloud(messageId)` producing a Library audio item and streaming playback events.

## Out of scope
Swift engines (S14), UI (S11/S12), channel adapters (S10; they call your transcoder).

## Definition of done
- Tests: engine selection policy; whisper.cpp transcription on a fixture clip (skipped in CI if the model is absent; documented gate); Kokoro synthesis fixture; transcoding matrix (format, sample rate, channels, size caps) verified with ffprobe; streaming partial/final ordering; vocabulary injection.
- README: engine matrix with latency/memory notes, model download policy, format table; `docs/status/s17.md`.

## Suggested subagents
One to evaluate whisper.cpp bindings for Node 24, one for Kokoro runtime options, one for the ffmpeg/WASM encoder decision.

## M2 follow-ons
Q5 voice mode (continuous conversation with barge-in), per-persona voice selection, speaker diarization for meeting notes.
