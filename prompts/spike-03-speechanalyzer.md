# Spike 03 — On-device dictation from a Swift helper (SpeechAnalyzer vs Parakeet vs WhisperKit)

Time box: one day. You are a Psyche engineer (read `README.md`) running a throwaway Swift prototype in `spikes/dictation/` with a write-up in `docs/spikes/spike-03-speechanalyzer.md`. Branch `spike/03-speechanalyzer`. Do not touch any package.

## Read first
`prompts/_shared-rules.md`; `docs/02-architecture.md` §5 (dictation) and §6; `docs/07-tech-decisions.md` ADR-014; `research_notes/Psyche personal agent landscape/macos_vm_and_integration.md` KQ6.

## Question to answer
What is the best push-to-talk dictation engine for the Mac helper on macOS 26/27 and on macOS 14–15, measured by latency to first partial, final accuracy on a fixed script, memory, and integration complexity?

## Build
1. A command-line Swift tool that captures 16 kHz mono from `AVAudioEngine`, streams to an engine, prints volatile partials and finals with timestamps, and stops on key-up.
2. Engines: `SpeechAnalyzer` + `SpeechTranscriber` (progressive live preset) and `DictationTranscriber` with a custom vocabulary (the agent name, three contact names); FluidAudio Parakeet (Core ML, 320 ms chunks) if it builds; WhisperKit small/base.
3. A fixed 90-second script read aloud twice (quiet room, with background music); compute WER against the script and measure first-partial latency and peak memory.
4. Check authorization requirements (microphone vs speech recognition), model download behavior, and behavior when offline.

## Report
Table of latency/WER/memory per engine and OS, the recommended default and fallback, code snippets for the helper (S14), and any amendment to ADR-014.
