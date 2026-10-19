# Spike 03: On-device push-to-talk dictation (SpeechAnalyzer vs Parakeet vs WhisperKit)

- **Status:** done, 2026-10-19 (one-day time box)
- **Code:** [`spikes/dictation/`](../../spikes/dictation/README.md) (`swift build -c release`, then `./bench.sh` and `./summarize.py`)
- **Machine:** MacBook Pro (Apple M5, 16 GB), macOS 27.0.1, Xcode 27.1, Swift 6.4. FluidAudio 0.17.7, WhisperKit 1.1.1 (`argmax-oss-swift`).
- **Informs:** ADR-014, architecture §5 (dictation) and §6 (`speech.transcribe`), feature Q1 and J9, S14 (`apps/mac-helper`), S17 (`packages/speech`)

## Question

Which push-to-talk dictation engine should the Mac helper use on macOS 26/27, and which on macOS 14–15? The criteria are latency to the first partial, accuracy on a fixed script, memory, and how hard the engine is to integrate.

## Answer

| | Default | Fallback |
| --- | --- | --- |
| **macOS 26+** | `SpeechAnalyzer` + **`DictationTranscriber`** (`progressiveLongDictation`), with the agent name and contact names as `AnalysisContext.contextualStrings` | `SpeechTranscriber` (`progressiveTranscription`) when no vocabulary is passed, or for a locale `DictationTranscriber` lacks |
| **macOS 14–15** | **FluidAudio Parakeet TDT 0.6B v2** (English; v3 for the 25 European languages), re-decoding the push-to-talk buffer every 320 ms for partials and once at key-up for the final text | WhisperKit `base` with a pinned local model folder, only for languages Parakeet does not cover |

Why:

- **DictationTranscriber + vocabulary** had the best accuracy among Apple engines: 3.0–3.4% WER on both reads, against 6.5% without the vocabulary. The vocabulary got the agent name right 4 of 4 times; without it, every engine but WhisperKit with a prompt got it 0 of 4.
  - It downloads nothing for English, because the en_US model is already on disk for system dictation.
  - It costs about 15 MB in the helper; the model runs in Apple's `localspeechrecognition` XPC service.
  - It works offline and needs no Speech Recognition permission.
  - Its cost: the first correct partial arrives about 0.8 s after speech starts, and the final text 0.3–0.6 s after key-up.
- **Parakeet TDT v2** was the most accurate open engine: 3.8–4.2% WER and 0.1–0.25 s from key-up to final text. It peaks at 90–105 MB in-process, is a 443 MB download, and works offline.
  - It runs on macOS 14 and beats both the streaming Parakeet model (EOU) and WhisperKit on accuracy and on time to first correct partial.
- **No engine meets Q1's "< 500 ms to first partial"** measured from the start of speech. The best was SpeechTranscriber at 0.61 s, which lands in the middle of the first word (that word lasts 0.75 s).
  - The amendment below rewrites the target so that it can be measured and met.

## Method

- **Script:** a fixed 263-word dictation script ([`script.txt`](../../spikes/dictation/script.txt)): messages and reminders to three contacts, with the agent name used four times.
  - Agent name: "Ondine".
  - Contacts: "Ngozi Adeyemi", "Kaveh Farrokhzad", "Marisol Echeverria".
  - These seven name words (13 occurrences) are the custom vocabulary and the "names" column below.
- **Audio:** nobody was available to read aloud, so the script was synthesized with the Siri "Nora" natural voice (`tts.swift`) into 87.8 s of speech. That speech was then turned into three reads:
  - **clean**: the speech padded with digital silence (exact zeros);
  - **quiet**: clean plus a −60 dBFS noise floor, like a quiet room into a real microphone;
  - **music**: quiet plus synthetic music (chords, bass, kick, hi-hat) at 10 dB SNR.
  - Every read starts with exactly 0.5 s of lead-in before the first word.
  - TTS is cleaner and more regular than a person. Its pronunciation of the surnames is a guess, which hurts every engine on those names equally.
- **Streaming:** each read is streamed into the engine in real time, as 100 ms 16 kHz mono Float32 buffers (roughly what an `AVAudioEngine` tap delivers). The last buffer counts as key-up.
- **Sessions per process:** each run is a separate process.
  - First, a 4 s utterance (the first push-to-talk after launch).
  - Then the whole 88 s read (warm).
- **Measures:**
  - **first correct partial:** time from the first word's onset until a hypothesis starting with that word appears. Filler hallucinations such as "Mm-hmm." do not count.
  - **final:** time from key-up to the final transcript.
  - **WER:** against the script, after lowercasing, stripping punctuation and spelling out numbers ("15" → "fifteen").
  - **helper peak:** `phys_footprint` peak.
  - **Apple daemon memory:** RSS of `localspeechrecognition`, sampled every 0.25 s.
- **Machine load:** the Mac was shared with other build sessions during the runs, and the Claude app crashed twice mid-benchmark. Expect jitter of a few hundred milliseconds, and treat single outliers as outliers (they are listed below).

## Results (macOS 27.0.1, M5)

Headline, quiet read (the realistic case) plus WER on the music read. All runs are warm and English.

| Engine | OS | First correct partial | Partial cadence | Final after key-up (4 s / 88 s utterance) | WER quiet / music | Names (of 13) | Helper peak | Outside the helper | Custom vocab | Model download, licence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SpeechTranscriber (`progressiveTranscription`) | 26+ | **0.61 s** | ~1.0 s | 0.08 / 0.19 s | 5.3% / 5.7% | 2 | 16 MB | 57–81 MB RSS in `localspeechrecognition` | no effect | none for en_US (system asset), system licence |
| DictationTranscriber (`progressiveLongDictation`) + contextual strings | 26+ | 0.82 s | ~0.3 s | 0.27 / 0.55 s | **3.4% / 3.0%** | 7 | 15 MB | 130–200 MB RSS | yes | none for en_US |
| DictationTranscriber, no vocabulary (clean/music) | 26+ | 0.83 s | ~0.3 s | 0.5–0.6 / 1.1–1.8 s | 6.5% / 6.5% | 2 | 15 MB | 117–136 MB RSS | — | none |
| Parakeet TDT 0.6B v2, re-decode every 320 ms | 14+ | 0.75 s | ~0.4 s | **0.10 / 0.25 s** | 4.2% / 4.2% | 5 | 90–105 MB | — | CTC boosting exists (not tested) | 443 MB, CC-BY-4.0 |
| Parakeet EOU 120M streaming, 320 ms | 14+ | 1.12 s | ~0.3 s | 0.01 / 0.01 s | 7.2% / 6.1% | 2 | 119–125 MB | — | no | 214 MB per chunk size, NVIDIA Open Model License |
| Parakeet EOU 120M streaming, 160 ms (clean/music) | 14+ | 1.52 s | ~0.3 s | 0.03–0.18 / 0.09 s clean, **20.7 s music** (falls behind real time) | 12.2% / 14.1% | 0 | 122–125 MB | — | no | 214 MB |
| WhisperKit base.en, streaming loop | 14+ | 1.57 s | ~1.0 s | 0.18 / 0.13 s | 8.0% / 6.8% | 3 | 123–141 MB | — | prompt tokens | 140 MB, MIT |
| WhisperKit small.en, streaming loop (clean/music) | 14+ | 1.66 s | ~1.0 s | 0.6–0.75 / 0.4–0.5 s | 6.8% / 5.7% (**34.6%** in one earlier run) | 6 | 150 MB | — | prompt tokens | 479 MB, MIT |
| WhisperKit small.en + vocabulary prompt + full decode at key-up (clean/music) | 14+ | 1.93 s | ~1.0 s | 1.0–1.1 / 4.7–7.7 s | 1.5% / 9.5% | 12 / 11 | 156–161 MB | — | yes | 479 MB |

Rows marked clean/music were not rerun on the quiet read. Their first-partial figures come from the music read, because the digital silence in the clean read distorts SpeechTranscriber (see finding 1).

- **macOS 14–15 was not measured.** No such host was available, and a VM guest has no Neural Engine, so a guest's numbers would not be representative.
  - Parakeet and WhisperKit use the same Core ML models with a macOS 14 deployment target, so expect the same WER.
  - Latency on 14–15 depends on the chip's Neural Engine: M1-class Macs will be slower than this M5.
  - Rerunning `bench.sh` on a macOS 15 Mac is a follow-up.
- **Load time** (warm process start, models cached):
  - Apple: 0.1–0.5 s.
  - Parakeet: 0.3–0.6 s (one 2.0 s outlier).
  - WhisperKit: 3–8 s, mostly a Hugging Face lookup (see finding 6). With a pinned local folder it is 0.44 s.
- **First launch after install:** includes the download and Core ML compile. On this connection it took EOU 76 s, TDT 368 s, Whisper base 1,000 s and small 310 s. The helper must download in the background and show progress.
- **Cold Apple start:** killing `localspeechrecognition` before a run changed nothing measurable (first partial 0.52 s for SpeechTranscriber and 0.74 s for DictationTranscriber, by the raw onset measure).

The full 31-row table, with every engine on every read, is in the [appendix](#appendix-all-runs).

## Findings that matter for the helper (S14)

1. **Digital silence delays SpeechTranscriber by ~0.9 s.**
   - On the clean read (exact zeros before the first word), SpeechTranscriber's first correct partial came at 1.51 s.
   - The same speech with a −60 dBFS noise floor, or with music underneath, gave 0.61 s.
   - DictationTranscriber and the open engines did not care.
   - A real microphone never sends exact zeros. Do not hard-gate or zero-fill audio in the renderer before it reaches the helper.
2. **A transcriber module cannot be reused across analyzers.**
   - Adding a `SpeechTranscriber` that already served a finished `SpeechAnalyzer` to a new analyzer traps inside Speech.framework. It is an `EXC_BREAKPOINT` in `TranscriberCommon.worker.setter`, not a thrown error.
   - Create a fresh module and analyzer per utterance, and keep the model warm with `modelRetention: .processLifetime` or `.lingering`.
   - S14's PR already creates them per stream.
3. **Only DictationTranscriber uses `contextualStrings`.**
   - On SpeechTranscriber, the same context changed no word (2/13 names with and without it). Once, finalization took 3.25 s instead of ~0.1 s.
   - Even on DictationTranscriber, the vocabulary fixed the agent name (4/4) and "Echeverria" but not "Ngozi Adeyemi" or "Kaveh Farrokhzad". This matters for contact names.
   - A `SFSpeechLanguageModel` custom language model (`ContentHint.customizedLanguage`) is the next lever. It was not tested.
4. **`fastResults` did nothing measurable.**
   - SpeechTranscriber emits volatile results on a ~1 s grid; adding `.fastResults` to the preset changed neither first partial nor WER.
   - DictationTranscriber updates about every 0.3 s.
5. **Short buffers make Parakeet TDT hallucinate fillers.**
   - Decoding 0.3–0.5 s buffers produced "Mm-hmm.", "Yeah." and "And" before the first real word.
   - Do not show partials until about 0.6 s of speech has arrived (or a VAD says speech started).
   - The final decode at key-up was never affected.
6. **WhisperKit is fragile for push-to-talk.**
   - The `AudioStreamTranscriber`-style loop re-decodes from the last confirmed segment. It sometimes hallucinates and drops text: one whisper-small run scored 34.6% WER with an invented "on the internet and I'm a fan of the internet" in place of a paragraph, while another scored 6.8%.
   - A full decode at key-up fixes drops but is slow on long utterances (4–40 s for 88 s of audio), and once hallucinated badly (38.8% WER, base, music).
   - With `download: true`, it calls Hugging Face on every launch to resolve the model name. It **fails offline even when the model is cached** (`modelsUnavailable … Operation not permitted`).
   - It downloads into `~/Documents/huggingface` by default, which would trigger the Documents-folder TCC prompt and sync through iCloud.
   - Pass `modelFolder` and `download: false`, and set `downloadBase` to the helper's Application Support folder.
7. **The streaming Parakeet model (EOU) is not worth it for push-to-talk.**
   - Its "320 ms" mode decodes a 630 ms window every 320 ms, so its first partial (1.1 s) is later than TDT's re-decode (0.75 s), and it is less accurate (6–7% WER).
   - The 160 ms mode is worse on both counts, and with music it fell 20 s behind real time.
   - Its one advantage, an instant final, does not matter when TDT finalizes in 0.1–0.25 s.
8. **Cold-path outliers exist on Apple engines.**
   - Once, a first utterance with DictationTranscriber+vocabulary took 19.9 s to finalize, on a loaded machine right after a 3 s load.
   - Give key-up a timeout (about 2 s), fall back to the last volatile text, and log it.
9. **Audio format.**
   - `SpeechAnalyzer.bestAvailableAudioFormat` returned 16 kHz Int16 mono for both transcribers. Convert with `AVAudioConverter`; on macOS 27, `AnalyzerInputConverter` does it for you.
   - FluidAudio and WhisperKit take 16 kHz Float32.

## Authorization, model download, offline

- **Speech Recognition permission is not needed for SpeechAnalyzer.**
  - Both transcribers ran with `SFSpeechRecognizer.authorizationStatus() == .notDetermined`, with no prompt.
  - Only the `SFSpeechRecognizer` fallback needs it.
  - Architecture §6 lists "Microphone, Speech Recognition" for `speech.transcribe`. That should read "Microphone (when the helper captures); Speech Recognition only for the `SFSpeechRecognizer` fallback".
  - Architecture §5 captures audio in the renderer, so in the default topology the **helper needs no TCC grant for dictation**; Psyche.app needs Microphone.
- **Microphone:** the tool's `--mic` push-to-talk path (hold ⌥) was built but **not exercised live**. The run was unattended, and a TCC prompt on the user's screen was avoided. A command-line tool also needs `NSMicrophoneUsageDescription` linked into `__TEXT,__info_plist`; the spike does this.
- **Apple model download:**
  - en_US was already on disk, because system dictation shares it. `AssetInventory.status` reported `.supported` until the app reserved the locale.
  - `assetInstallationRequest` then reserved it at once. An app may reserve at most 5 locales (`maximumReservedLocales`).
  - A new locale (fr-FR) downloaded and installed in **17.2 s**. The request's `Progress` reports a fraction, not bytes (`totalUnitCount` 1).
  - `AssetInventory.release(reservedLocale:)` gives a slot back.
  - SpeechTranscriber supports 45 locales on this Mac, DictationTranscriber 54.
- **Open-model download:** FluidAudio saves to `~/Library/Application Support/FluidAudio/Models` (Hugging Face, `FluidInference/*`). WhisperKit saves to `~/Documents/huggingface` unless `downloadBase` is set.
- **Offline**, tested with IP networking denied to the process by `sandbox-exec`:
  - SpeechTranscriber worked. `lsof` showed no IP sockets on `localspeechrecognition` during a run.
  - Parakeet TDT worked from its cache.
  - WhisperKit failed until it was given a local folder (finding 6).
  - Turning Wi-Fi off was not tested; the sandbox only restricts the spike's own process.

## Code for the helper (S14)

These are complete versions of what the spike runs ([`Engines.swift`](../../spikes/dictation/Sources/dictation-spike/Engines.swift)).

**macOS 26+: one analyzer per push-to-talk utterance**

```swift
// prepare once
let locale = await DictationTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US"))!
// begin (key-down): fresh module + analyzer every time (reusing a module traps)
let module = DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
if await AssetInventory.status(forModules: [module]) != .installed,
   let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
    try await request.downloadAndInstall()          // report request.progress.fractionCompleted
}
let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module])!  // 16 kHz Int16 mono
let analyzer = SpeechAnalyzer(modules: [module],
                              options: .init(priority: .userInitiated, modelRetention: .processLifetime))
let context = AnalysisContext()
context.contextualStrings[.general] = ["Ondine", "Ngozi Adeyemi", "Kaveh Farrokhzad", "Marisol Echeverria"]
try await analyzer.setContext(context)
try await analyzer.prepareToAnalyze(in: format)
let (input, feed) = AsyncStream<AnalyzerInput>.makeStream()
let results = Task {
    var finalized = ""
    for try await r in module.results {
        let text = String(r.text.characters)
        if r.isFinal { finalized += (finalized.isEmpty ? "" : " ") + text; emitPartial(finalized) }
        else { emitPartial(finalized + " " + text) }
    }
    return finalized
}
try await analyzer.start(inputSequence: input)
// each buffer: convert Float32 → format with AVAudioConverter (or AnalyzerInputConverter on 27)
feed.yield(AnalyzerInput(buffer: converted))
// key-up
feed.finish()
try await analyzer.finalizeAndFinishThroughEndOfInput()
let transcript = try await results.value            // wrap in a ~2 s timeout; fall back to the last partial
```

**macOS 14–15: Parakeet TDT v2 with re-decode partials**

```swift
let models = try await AsrModels.downloadAndLoad(version: .v2)   // .v3 for European languages
let asr = AsrManager(config: .default)
try await asr.loadModels(models)
func decode(_ samples: [Float]) async throws -> String {
    var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
    return try await asr.transcribe(samples, decoderState: &state).text
}
// while the key is held: append 16 kHz Float32 samples; every 5,120 new samples (320 ms), if no decode is
// in flight and at least ~0.6 s of speech has arrived, decode the whole buffer and show it as the partial.
// key-up: await the in-flight decode, then `decode(all)` for the final text (0.1–0.25 s here).
```

**WhisperKit, if used at all**

```swift
let kit = try await WhisperKit(WhisperKitConfig(
    modelFolder: appSupport + "/whisperkit/openai_whisper-base.en",   // never ~/Documents, never a name lookup
    prewarm: true, load: true, download: false))
var options = DecodingOptions(language: "en", skipSpecialTokens: true)
options.promptTokens = kit.tokenizer!.encode(text: " Ondine, Ngozi Adeyemi, Kaveh Farrokhzad.")
    .filter { $0 < kit.tokenizer!.specialTokens.specialTokenBegin }
```

## Amendments

**ADR-014** (proposed wording for the decision):

> `SpeechAnalyzer` on macOS 26+, with `DictationTranscriber` and `contextualStrings` (the agent name and contacts) as the push-to-talk default and `SpeechTranscriber` when no vocabulary applies; FluidAudio Parakeet TDT 0.6B v2 (v3 for non-English European languages) on macOS 14–15, partials by re-decoding the held buffer; WhisperKit only for languages Parakeet lacks, with a pinned local model folder; `SFSpeechRecognizer` last; whisper.cpp on Linux. The streaming Parakeet EOU model is not used for push-to-talk. Apple's transcribers need Microphone only, not Speech Recognition.

Add to the evidence: this spike's table. The 0.19 s FluidAudio figure in the current evidence is batch latency on a short clip; streaming partials measured 0.75 s here.

**Q1 "done when"** (proposed):

> First partial visible within 700 ms of speech onset (in practice, during the first word) and the final text within 500 ms of key-up for utterances under 15 s, on Apple Silicon; the agent name is transcribed correctly with the vocabulary on.

The current "< 500 ms to first partial" was missed by every engine measured, Apple's included. The proposed final-text target is met by DictationTranscriber (0.27 s on the 4 s utterance) and by Parakeet TDT (0.10 s).

**Architecture §6:** the `speech.transcribe` row's TCC column (see "Authorization" above), and "FluidAudio Parakeet TDT" instead of "FluidAudio Parakeet or WhisperKit" in §5.

**S14 (PR #47):** replace the interim macOS 15 `SFSpeechRecognizer` engine with Parakeet TDT v2. Add the key-up timeout (finding 8), and do not request Speech Recognition authorization for the SpeechAnalyzer paths.

## Not covered and follow-ups

- **macOS 14–15 numbers:** rerun `bench.sh` on a macOS 15 Mac, ideally an M1, for the Parakeet and WhisperKit rows.
- **A real voice:** read `script.txt` into the microphone with `dictation-spike run --engine … --mic --script script.txt` (hold ⌥). Do it in a quiet room and with music playing, as the prompt intended, especially for the contact names.
- **Short utterances:** typical push-to-talk is 2–15 s. Only the 4 s first-utterance session covers that; a set of 20 short utterances would give real distributions.
- **Custom language models:** `SFSpeechLanguageModel` for contact names on DictationTranscriber, and FluidAudio's CTC vocabulary boosting for Parakeet TDT.
- **Combined modules:** running SpeechTranscriber (faster first partial) and DictationTranscriber (vocabulary) in one `SpeechAnalyzer` was not tried.

## Appendix: all runs

Every engine on every read, warm, produced by `./summarize.py`. Caveats:

- Clean/music rows recorded update times only; the partial-cadence column for them is the mean gap between all updates, which bursts of words push down.
- Clean/music rows for Parakeet TDT predate the hallucination filter, so their first partial (near 0 s) is a filler hallucination.
- The daemon-RSS column only means something for Apple engines. Elsewhere it shows whatever Apple daemon was still resident from the previous run.

| engine | read | load s | first correct partial s (4 s / 88 s utterance) | partial cadence s | final after key-up s (4 s / 88 s) | WER | names | helper peak MB | speech daemons peak RSS MB |
|---|---|---|---|---|---|---|---|---|---|
| dictation | clean | 0.21 | 0.89 / 0.82 | 0.27 | 0.61 / 1.81 | 6.5% | 2/13 | 15 | 117 |
| dictation-vocab | clean | 0.31 | 0.88 / 0.84 | 0.27 | 0.43 / 2.34 | 3.0% | 7/13 | 15 | 131 |
| parakeet-eou | clean | 0.61 | 1.12 / 1.13 | 0.38 | 0.01 / 0.03 | 6.8% | 2/13 | 119 | 56 |
| parakeet-eou-160 | clean | 0.63 | 1.53 / 1.52 | 0.27 | 0.03 / 0.09 | 12.2% | 0/13 | 125 | – |
| parakeet-tdt | clean | 2.02 | 0.18 / -0.04 | 0.67 | 0.27 / 0.88 | 3.8% | 6/13 | 101 | 6 |
| speech | clean | 0.25 | 1.52 / 1.51 | 0.25 | 0.14 / 0.09 | 5.7% | 2/13 | 16 | 63 |
| speech-fast | clean | 0.25 | 1.51 / 1.51 | 0.25 | 0.12 / 0.16 | 5.7% | 2/13 | 16 | 57 |
| speech-vocab | clean | 0.41 | 1.52 / 1.51 | 0.25 | 0.10 / 3.25 | 5.7% | 2/13 | 16 | 59 |
| whisper-base | clean | 5.23 | 1.87 / 1.59 | 1.01 | 0.20 / 0.21 | 7.2% | 3/13 | 123 | 6 |
| whisper-base-final | clean | 4.59 | 1.84 / 1.59 | 1.07 | 0.24 / 40.52 | 7.6% | 2/13 | 126 | 13 |
| whisper-small | clean | 5.21 | 2.18 / 1.68 | 1.05 | 0.75 / 0.40 | 6.8% | 6/13 | 150 | 8 |
| whisper-small-final | clean | 3.35 | 1.70 / 1.66 | 1.05 | 0.58 / 3.87 | 6.1% | 5/13 | 153 | – |
| whisper-small-final-vocab | clean | 2.79 | 1.96 / 1.93 | 1.65 | 1.00 / 4.73 | 1.5% | 12/13 | 156 | – |
| dictation | music | 0.46 | 0.87 / 0.83 | 0.28 | 0.49 / 1.11 | 6.5% | 2/13 | 15 | 136 |
| dictation-vocab | music | 3.05 | 4.32 / 0.85 | 0.28 | 19.90 / 0.64 | 3.0% | 7/13 | 15 | 144 |
| parakeet-eou | music | 0.48 | 1.13 / 1.13 | 0.39 | 0.03 / 0.03 | 6.1% | 2/13 | 123 | – |
| parakeet-eou-160 | music | 2.18 | 2.34 / 1.54 | 0.31 | 0.18 / 20.67 | 14.1% | 0/13 | 122 | 19 |
| parakeet-tdt | music | 0.44 | -0.02 / -0.05 | 0.63 | 0.42 / 1.31 | 4.2% | 5/13 | 105 | 6 |
| speech | music | 0.10 | 0.62 / 0.61 | 0.25 | 0.06 / 0.16 | 5.7% | 2/13 | 15 | 78 |
| speech-fast | music | 0.20 | 0.63 / 0.62 | 0.25 | 0.11 / 0.19 | 5.7% | 2/13 | 16 | 61 |
| speech-vocab | music | 2.94 | 0.83 / 0.63 | 0.25 | 0.82 / 0.09 | 5.7% | 2/13 | 16 | 63 |
| whisper-base | music | 6.38 | 1.68 / 1.59 | 1.04 | 0.33 / 0.22 | 6.8% | 3/13 | 127 | 6 |
| whisper-base-final | music | 20.54 | 8.08 / 3.49 | 3.34 | 7.09 / 4.45 | 38.8% | 2/13 | 124 | 13 |
| whisper-small | music | 3.22 | 1.76 / 1.66 | 1.10 | 0.61 / 0.51 | 5.7% | 6/13 | 151 | – |
| whisper-small-final | music | 3.13 | 1.69 / 1.67 | 1.06 | 0.60 / 3.64 | 6.1% | 6/13 | 148 | – |
| whisper-small-final-vocab | music | 11.88 | 1.98 / 1.93 | 1.05 | 1.12 / 7.73 | 9.5% | 11/13 | 161 | 6 |
| dictation-vocab | quiet | 0.13 | 0.85 / 0.82 | 0.30 | 0.27 / 0.55 | 3.4% | 7/13 | 15 | 202 |
| parakeet-eou | quiet | 0.37 | 1.14 / 1.12 | 0.30 | 0.01 / 0.01 | 7.2% | 2/13 | 125 | 208 |
| parakeet-tdt | quiet | 0.28 | 0.75 / 0.75 | 0.40 | 0.10 / 0.25 | 4.2% | 5/13 | 90 | 5 |
| speech | quiet | 0.15 | 0.62 / 0.61 | 0.99 | 0.08 / 0.19 | 5.3% | 2/13 | 16 | 81 |
| whisper-base | quiet | 7.83 | 1.63 / 1.57 | 1.00 | 0.18 / 0.13 | 8.0% | 3/13 | 141 | 5 |
