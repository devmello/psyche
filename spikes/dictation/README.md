# Spike 03: dictation engine comparison (throwaway)

A command-line Swift tool that streams 16 kHz mono audio into on-device dictation engines the way a push-to-talk helper would. It prints partials and finals with timestamps and scores the result against a fixed script.

**Never imported by any package.** Findings: [`docs/spikes/spike-03-speechanalyzer.md`](../../docs/spikes/spike-03-speechanalyzer.md).

## Engines (`--engine`)

| id | what |
| --- | --- |
| `speech`, `speech-fast`, `speech-vocab` | `SpeechAnalyzer` + `SpeechTranscriber` (`progressiveTranscription`, optionally `.fastResults` or `contextualStrings`), macOS 26+ |
| `dictation`, `dictation-short`, `dictation-vocab` | `SpeechAnalyzer` + `DictationTranscriber` (`progressiveLongDictation` / `progressiveShortDictation`, optionally `contextualStrings`), macOS 26+ |
| `parakeet-eou`, `parakeet-eou-160` | FluidAudio streaming Parakeet EOU 120M, 320 ms or 160 ms chunks |
| `parakeet-tdt` | FluidAudio Parakeet TDT 0.6B v2, re-decoding the held buffer every 320 ms |
| `whisper-{base,small}[-final][-vocab]` | WhisperKit `*.en`, `AudioStreamTranscriber`-style loop; `-final` does one full decode at key-up, `-vocab` adds a prompt |

## Run

```bash
swift build -c release
swift tts.swift script.txt audio/nora-raw.caf com.apple.siri.natural.Nora 0.45   # needs the Siri "Nora" voice
.build/release/dictation-spike make-audio --speech audio/nora-raw.caf --out audio  # clean / quiet / music reads
./bench.sh                       # ENGINES="speech parakeet-tdt" INPUTS=quiet ./bench.sh to narrow
./summarize.py '*-quiet'         # markdown table from results/*.json
```

Other commands:

- `dictation-spike run --engine dictation-vocab --mic --script script.txt`: live microphone; hold ⌥ to talk, release to stop. Add `--seconds N` for a timed capture.
- `dictation-spike auth [--request]`: TCC status, the locales each transcriber supports and has installed, and asset status.
- `dictation-spike asset --locale fr-FR --release`: times an `AssetInventory` download, then releases the locale.
- `WHISPER_MODEL_FOLDER=<dir>` loads WhisperKit models from a local folder with `download: false`, which works offline.

`Info.plist` is linked into `__TEXT,__info_plist` so that the microphone and speech-recognition prompts have usage strings. Models download to `~/Library/Application Support/FluidAudio` and `~/Documents/huggingface` (WhisperKit's default).
