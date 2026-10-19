# @psyche/speech

**Owner:** S17 (`prompts/s17-*.md`). Feature ids: Q1 (Q3, Q4, N11) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

STT/TTS abstractions, whisper.cpp path, voice-note transcoding.

## Status

Placeholder created by S00 (bootstrap). `createSpeechEngine()` throws `NotImplementedError` until S17 lands the real `SpeechEngine` implementation.

## How this package maps to the docs

- Architecture: [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model: [docs/04-data-model.md](../../docs/04-data-model.md)
- Security rules: [docs/05-security-and-permissions.md](../../docs/05-security-and-permissions.md)
- Contract: `packages/protocol/src/contracts/SpeechEngine.ts`, fake: `packages/testing/src/fakes/FakeSpeechEngine.ts`

## Rules

Edit only this package (see `prompts/_shared-rules.md`). Cross-package needs go through `packages/protocol` contracts and the fakes in `packages/testing`.
