# Apple on-device speech for voice mode

Research for the voice conversation mode spec (S17). Researched 2026-10-25 against Apple's current documentation (macOS 26 Tahoe and macOS 27), WWDC sessions and project sources. Measured numbers come from Psyche's own spike 03 and the helper README, not from Apple. Apple publishes no latency figures for any of these APIs.

## Answers for the spec

1. **Speech-to-text:** keep `SpeechAnalyzer`. Use `DictationTranscriber` (`progressiveLongDictation`) with `contextualStrings` when there is vocabulary, and `SpeechTranscriber` (`progressiveTranscription`) otherwise. Create one analyzer per turn. Budget 0.6–0.8 s from speech onset to the first correct partial, and 0.1–0.6 s from end of input to the final text. WER was 3.0–3.4% with vocabulary and 5.3–6.5% without (spike 03). It runs on device, its models are system assets shared with other apps, and it needs no Speech Recognition permission.
2. **End of turn:** Apple's `SpeechDetector` cannot drive end-of-turn or barge-in. Its results currently report only VAD-model errors, not speech start or end [2]. Psyche keeps its own VAD (the energy VAD with 0.9 s end-of-turn that exists today). If that VAD proves too weak, the candidates are WebRTC VAD (BSD-3-Clause, not a neural network) or Silero VAD (MIT, 1.2–2.3 MB ONNX, under 1 ms per 30 ms chunk).
3. **Text-to-speech:** keep `AVSpeechSynthesizer.write(_:toBufferCallback:)` streaming PCM. First audio measured about 0.8 s cold. Siri voices are not available to apps [16]. Enhanced and premium voices work once the user has downloaded them; each is over 100 MB, and there is no API to start the download. Personal Voice stays opt-in: the macOS 26 licence §2.F limits it to "personal, non-commercial use" [19].
4. **Wake word:** push-to-talk is the default. A wake word stays off and is not in v1. Porcupine is excluded: an AccessKey is required, and the free tier ended on 2026-06-30. If a wake word is ever added, use openWakeWord (Apache-2.0 code, CC BY-NC-SA 4.0 models, about 2.6–4.1 MB) or microWakeWord (Apache-2.0, 52–60 KB models). A keyword spotter is a small audio classifier, not a language model, so it does not break the spirit of the "no local LLMs" rule. The owner's rule text does say "any other local model", though, so this needs the owner's explicit yes.
5. **Echo and barge-in:** keep microphone capture and TTS playback in one echo-cancellation domain. Today that domain is the renderer (Chromium AEC with Web Audio playback; see `psyche-today.md`). If the helper ever captures, use VPIO and play TTS through an `AVAudioPlayerNode` on the same engine, attached before voice processing is enabled. On laptop speakers, a barge-in needs about 300 ms or more of speech plus at least one transcribed word, and a 500–800 ms hold after playback ends.
6. **Mic indicator:** the orange dot stays on while any process holds an input stream. It is attributed to the responsible process: Psyche.app for renderer capture, Psyche Helper if the helper captures. Voice mode must therefore close capture on every exit path and never keep it warm. #611 was this bug, and PR #613 fixed it with a 2 s force-release watchdog. The fix is not yet verified on an installed build.

## 1. SpeechAnalyzer, SpeechTranscriber, DictationTranscriber, SpeechDetector

### Model and streaming

- `SpeechAnalyzer` (actor, macOS 26+) runs a session over one or more modules: `SpeechTranscriber`, `DictationTranscriber` and `SpeechDetector` [1][8]. Audio goes in as an `AsyncSequence<AnalyzerInput>`, and each module delivers its own `results` sequence.
- **Volatile vs final:** with volatile results on, the transcriber sends fast, less accurate guesses for an audio range, then a final result that replaces them. Once a range is final, it gets no more results [1]. Each result covers a non-overlapping audio time range, and the transcriber does not keep a running transcript; the app assembles it (final text plus the current volatile tail, or replacement by `audioTimeRange`) [12].
- All operations are scheduled on the audio timeline, and time codes are sample-accurate [1]. `finalizeAndFinish(through:)` or `finalizeAndFinishThroughEndOfInput()` forces the remaining volatile text to final; this is the "end of turn" call.
- **Presets:**
  - `SpeechTranscriber` [3]: `transcription`, `transcriptionWithAlternatives`, `timeIndexedTranscriptionWithAlternatives`, `progressiveTranscription`, `timeIndexedProgressiveTranscription`. Only the two progressive presets turn on `volatileResults` and `fastResults`.
  - `DictationTranscriber` [5]: `phrase`, `shortDictation`, `progressiveShortDictation` (short form, volatile results, `frequentFinalization`), `longDictation`, `progressiveLongDictation`, `timeIndexedLongDictation`.
  - **For conversation turns:** `progressiveShortDictation` is the preset to try. It is meant for "about a minute of live audio" and finalizes frequently [5]. Spike 03 measured only `progressiveLongDictation`, so the latency of `progressiveShortDictation` is **unverified**.
- **Engines:**
  - `DictationTranscriber` uses the same models as system dictation and on-device `SFSpeechRecognizer`. It supports `contextualStrings`, custom language models (`ContentHint.customizedLanguage(modelConfiguration:)`, built with `SFCustomLanguageModelData`) and a `farField` hint [4].
  - `SpeechTranscriber` is the newer long-form model. Check `isAvailable` for hardware support. Which Macs pass is **unverified**; Apple says only "certain hardware requirements" [1][8].

### Vocabulary

- `AnalysisContext.contextualStrings` is a dictionary of tag → strings: "words or phrases … that should be recognized even if they are not in the system vocabulary" [6]. Apple documents it under `DictationTranscriber` [4]. Spike 03 found that `SpeechTranscriber` ignores it (2 of 13 names with and without it).
- With vocabulary, `DictationTranscriber` got the agent name right 4 of 4 times. It still missed two of three contact surnames. A custom language model with pronunciations (shown in Apple's macOS/iOS 27 sample [12]) is the next lever. It is untested in Psyche.

### Locales and assets

- Models are system assets "downloaded from Apple's servers and managed by the system", shared with other apps and updated automatically [7].
- `AssetInventory.assetInstallationRequest(supporting:)` returns `nil` when nothing needs installing; otherwise call `downloadAndInstall()` and watch its `progress` [1][7]. Each app has a limited number of locale reservations (`maximumReservedLocales`; 5 on the spike Mac). `release(reservedLocale:)` frees one, and the system may unsubscribe assets that have not been used recently [7].
- **Measured** (spike 03, macOS 27.0.1, M5):
  - en_US was already on disk, because system dictation shares it.
  - Downloading fr-FR took 17.2 s. Progress is a fraction, not bytes.
  - `SpeechTranscriber` listed 45 locales and `DictationTranscriber` 54.
- **On-device:** "transcription is entirely on device but the models need to be fetched" [1]. The model runs outside the app's memory [1]; in spike 03 that was the `localspeechrecognition` daemon, at 57–200 MB RSS. Spike 03 also ran `SpeechTranscriber` with IP networking denied to the spike process, and `lsof` showed no IP sockets on the daemon. Neither transcriber needs Speech Recognition permission; only Microphone, and only if the process captures audio.

### Latency (Psyche measurements; Apple gives none)

| Engine (spike 03, quiet read, warm) | First correct partial after speech onset | Partial cadence | Final after end of input (4 s / 88 s utterance) | WER |
| --- | --- | --- | --- | --- |
| `SpeechTranscriber` `progressiveTranscription` | 0.61 s | ~1.0 s | 0.08 / 0.19 s | 5.3% |
| `DictationTranscriber` `progressiveLongDictation` + vocabulary | 0.82 s | ~0.3 s | 0.27 / 0.55 s | 3.4% (3.0% with music) |
| `DictationTranscriber`, no vocabulary | 0.83 s | ~0.3 s | 0.5–0.6 / 1.1–1.8 s | 6.5% |

- **Caveats from spike 03:**
  - Digital silence (exact zeros) delays `SpeechTranscriber` by about 0.9 s, so never zero-gate audio before it reaches the analyzer.
  - Reusing a module across analyzers traps inside Speech.framework, so create a fresh module and analyzer per turn and keep the model warm with `modelRetention`.
  - `.fastResults` changed nothing measurable.
  - One cold-path finalize took 19.9 s, so put a timeout of about 2 s on finalize and fall back to the last volatile text.
- **Helper README bench** (6 s clip): first partial 1.04 s with `SpeechTranscriber` and 0.75 s with `DictationTranscriber`; finalize 55–115 ms.
- **For voice mode:** the user hears nothing until end-of-turn detection plus finalize plus the agent's first token plus TTS first audio. Finalize (0.1–0.6 s) is the only part STT adds after the VAD fires. The partials matter for display and for barge-in confirmation, not for reply latency.

### SpeechDetector (Apple's VAD module)

- `SpeechDetector` (macOS 26+) is "a module that performs a voice activity detection (VAD) analysis". It gates transcription by the presence of voices to save power [2].
- **API:**
  - `init()` and `init(detectionOptions:reportResults:)`.
  - `DetectionOptions` carries a `SensitivityLevel`. Apple recommends `medium`; the documentation lists no other case by name.
  - `results` delivers `SpeechDetector.Result`.
  - It works only alongside a `SpeechTranscriber` or `DictationTranscriber` [2].
- **Limits:**
  - Results "currently only support error handling from the VAD model" [2]. The detector gives the app no speech-start or speech-end events.
  - Apple warns that always-on VAD can drop speech and hurt accuracy [2].
- **Judgment:** use it, at most, to save power on long silences inside one listening session. It cannot drive end-of-turn or barge-in.
- **Not tested:** whether gaps in transcriber results while `SpeechDetector` is active can stand in for an end-of-speech signal. Treat that as **unverified**.

### macOS 27 changes (June 2026)

- Apple's Speech updates page lists two June 2026 additions [9]:
  - `AssetInputSequenceProvider` and `CaptureInputSequenceProvider`: audio from a file, or from an `AVCaptureDevice` through an `AVCaptureSession`, already converted for the analyzer [10].
  - `AnalyzerInputConverter`: buffer conversion with `convert(_:at:)` and `flush()` [11].
- The macOS/iOS 27 sample "Recognizing speech in live audio" uses `CaptureInputSequenceProvider` with `DictationTranscriber` and a custom language model, and stops by task cancellation [12].
- **No new modules:** I found no WWDC26 session on SpeechAnalyzer, and no new module such as diarization or a turn detector.
- **Impact on Psyche:** none on the push-PCM path, since the renderer captures and the helper receives pushed PCM. `AnalyzerInputConverter` can replace the helper's `AVAudioConverter` code on macOS 27.

## 2. AVSpeechSynthesizer and Personal Voice

### Voices

- **Qualities** [13]:
  - `default`: available on the device by default.
  - `enhanced` and `premium`: "you must download to use". Each download is over 100 MB, per a developer report [20]; Apple gives no size.
  - The user downloads them in System Settings › Accessibility › Read & Speak (formerly Spoken Content) › System voice › Info [21].
- **What an app can see:**
  - `speechVoices()` lists only installed voices, and there is no public API to list or start downloads (developer reports in [20]; no Apple API found).
  - Third-party apps may use any installed voice except Siri voices.
- **Siri voices:** Apple: Siri voices "are not available through the AVSpeechSynthesizer API". If one is the selected system voice, the API falls back to another voice for the same language [16].
  - Psyche's own spike saw consistent behaviour: the Siri "natural" voices were listed for the Apple-signed `swift` interpreter but not for the compiled spike binary (`spikes/dictation/tts.swift`).
  - Voice mode must not promise Siri-quality voices.
- **Licence for system voices:** the macOS 26 licence §2.F allows System Voices "while running the Apple Software" and for the user's own "personal, non-commercial use" [19].
  - Psyche is self-hosted for the owner, so speaking replies on the owner's Mac fits that clause.
  - Redistributing recordings would not fit. Do not save TTS audio to shared artifacts by default.
  - A forum reply says the voices "cannot be re-sold/commercialized" [22]. It is not an Apple ruling.

### Streaming, SSML, latency

- **Streaming:** `write(_:toBufferCallback:)` (macOS 10.15+) delivers generated audio as buffers [14].
  - Measured on macOS 27 (helper source comment): it only produces audio when the synthesizer is created and driven on the main thread, with the main run loop serviced.
  - Buffers arrive as Float32 mono, at 22.05 kHz for the compact voices, and a zero-length buffer marks the end.
  - The spike also saw zero-length buffers between paragraphs, so a zero-length buffer is not always the end of the utterance.
- **SSML:** `AVSpeechUtterance(ssmlRepresentation:)` (macOS 13+) returns `nil` for invalid SSML, and `rate` and `pitchMultiplier` do not apply to SSML utterances [15].
  - Apple shows `<break>` and `<prosody rate>` [17] and publishes no list of supported tags. Developer reports show `<prosody contour>` is ignored. Anything else is **unverified**.
  - Practical rule: send plain text per sentence and use only `break` and `prosody rate`.
- **Latency:** Psyche measured first audio at about 0.8 s cold (helper README). Apple publishes nothing. Warm latency, and latency with premium voices, are **unverified**.
  - Voice mode should synthesize sentence by sentence as the reply streams, rather than waiting for the whole reply.
  - It should reuse a warm synthesizer when the main-thread constraint allows.

### Personal Voice

- **Authorization:**
  - `AVSpeechSynthesizer.requestPersonalVoiceAuthorization` (macOS 14+) [18].
  - Once authorized, personal voices appear in `speechVoices()` with the `isPersonalVoice` trait [17].
  - The user must have created a voice (about 150 phrases, then hours of on-device processing) and turned on "Allow Apps to Request to Use". Without that switch, requests are denied automatically [20].
  - Status is `.denied` on unsupported hardware and `.unsupported` only on the Simulator, tvOS, watchOS and visionOS [20].
- **Apple's guidance:** Personal Voice "should be primarily used for augmentative or alternative communication apps" [17].
- **Licence:** §2.F limits it to the user's "personal, non-commercial use". It bars use "in a profit, non-profit, public sharing or commercial context" [19].
- **Psyche today:**
  - Personal Voice needs `personalVoice: true` on `speech.synthesize`.
  - Its result carries `nonCommercial: true`, and a personal voice id without the opt-in is refused.
  - **Keep it that way:** the default is off, the settings toggle states the licence terms, and Personal Voice output is never used in shared or exported audio.

## 3. Wake word

- **Apple:** there is no API for a third-party wake word. "Hey Siri" detection is private to the system.
  - Psyche can offer Siri invocation through App Intents / App Shortcuts phrases ("Siri, ask Psyche…"), at zero microphone cost to Psyche [46].
  - Whether App Shortcut phrases work through Siri on macOS is **unverified**; one developer report says they did not on macOS 13.
- **Always-on cost:**
  - Any wake word keeps an input stream open, so the orange dot stays on for the whole session, and Control Center names Psyche.
  - It sends every second of room audio through a classifier.
  - Battery cost on Apple silicon is likely small for a 50 KB–4 MB model, but it is **unverified**. Keeping the audio path awake costs extra, separate from the model.

| Option | Licence and terms | Model size | CPU | Custom keyword | Status |
| --- | --- | --- | --- | --- | --- |
| openWakeWord [23] | Code Apache-2.0. Pre-trained models CC BY-NC-SA 4.0 (non-commercial, share-alike). | Shared melspectrogram 1.09 MB + embedding 1.33 MB + head 0.2–1.7 MB per word (v0.5.1 assets) | 15–20 models on one Raspberry Pi 3 core; 80 ms frames | Train from synthetic TTS data (notebook/Colab) | Last release v0.6.0, 2024-02; repo active to 2025-12 |
| microWakeWord [24] | Apache-2.0 (code and the ESPHome model repo) | 52–60 KB `.tflite` (v2 models) | Built for ESP32; inference every 30 ms | Train with the Piper sample generator; "requires a lot of experimentation" | Active (2026-07) |
| Picovoice Porcupine [25][26][27] | SDK Apache-2.0, but every run needs a Console AccessKey, checked when the engine starts | not published (about 1 MB RAM, third-party figure) | <4% of a Pi 3 core (third-party figure) | Console training | Free tier ended 2026-06-30 (Picovoice replies quoted on a forum); "no dedicated free or paid plans for personal or non-commercial use" [26]. Excluded. |
| Snowboy [28] | Apache-2.0 | small | low | Needed KITT.AI servers | Dead: KITT.AI shut down all products by 2020-12-31 |
| Mycroft Precise [29] | Apache-2.0 | small (TensorFlow) | moderate | Self-trained | Unmaintained: no push since 2023-11; Mycroft AI ceased development in early 2023 |
| Apple Sound Analysis [30][31] | System framework | Create ML sound classifier, typically a few MB | Low, ~1 s windows | Train a custom classifier with `SNClassifySoundRequest(mlModel:)` | Built for sound events. Window-based (~1 s windows), with no false-accept tuning; untested for speaker-independent keywords. |

- **Sound Analysis for a keyword:** technically possible. Train a Create ML sound classifier on the keyword against negatives, and run `SNAudioStreamAnalyzer` with tuned `windowDuration`/`overlapFactor` [30].
  - But Apple designed and documents it for sound events, not keyword spotting. Accuracy on a spoken phrase across speakers is **unverified**.
  - Psyche lets the owner choose the agent name, so any keyword model would need training per name. That is the main practical obstacle for every option above.
- **ASR as the wake word:** running `SpeechTranscriber` continuously and matching the agent name needs no new model. It is still always-on capture, and it transcribes all room speech, which is worse for privacy and power than a classifier. Not recommended.
- **No-local-LLM rule:** the owner's rule (2026-10-19) is "No using local models right now", and it names Ollama, llama.cpp, LM Studio, MLX "or any other local model".
  - It was set because of machine load during development, and it targets language models.
  - A keyword spotter has no tokens, no generation and no prompts. It is a 50 KB–4 MB convolutional classifier with an output of about one probability per 80 ms.
  - Psyche already ships on-device ML for speech: Apple's transcribers, and Parakeet TDT on macOS 14–15 per ADR-014.
  - **Judgment:** a wake-word model does not conflict with the intent of the rule. Because the rule text says "any other local model", adding one needs the owner's explicit approval. Until then, development sessions must test wake-word code with recorded fixtures only and never run the model.
- **Recommendation:**
  - Push-to-talk, or a click to start the conversation, is the default.
  - Voice mode runs as a conversation session that the user starts, and capture closes when it ends.
  - The wake word is out of v1. If it is added later, it is off by default and labelled "always listening", and it uses microWakeWord or openWakeWord with a model the owner trains.
  - openWakeWord's pre-trained models are non-commercial share-alike, which fits a personal self-hosted install but not a redistributed bundle.

## 4. VAD, echo cancellation and barge-in on macOS

### Voice Processing I/O (VPIO)

- **Turning it on:** `inputNode.setVoiceProcessingEnabled(true)` (macOS 10.15+) turns on Apple's voice processing: echo cancellation, noise suppression and AGC [33].
  - It requires both I/O nodes in voice-processing mode, and enabling either node enables the other [32][36].
  - The engine must be stopped while it is toggled, and manual rendering is not supported [32].
  - Expect a "slight gain change" (an Apple engineer, [36]) and lower output volume.
  - Because the input node is enabled, a VPIO engine holds the microphone, and the orange dot is on whenever it runs. This follows from how VPIO works, but it is not tested.
- **What it cancels:** Apple says "any audio that is coming from the device is taken out" [32]. The canceller's reference is the audio rendered through the VPIO output.
  - Field reports agree that TTS must play through the same voice-processing engine that captures, attached before VPIO is enabled; otherwise echo remains [37].
  - Psyche's TTS path is `write(_:toBufferCallback:)` → buffers. Played through an `AVAudioPlayerNode` on that engine, it is in the reference.
  - `AVSpeechSynthesizer.speak(_:)` renders its own output, so it is almost certainly not cancelled. That is an inference; **unverified** on macOS.
  - Audio from other apps counts as "other audio": Apple says it is mixed with the voice audio and ducked, not cancelled [33].
- **Ducking:** `voiceProcessingOtherAudioDuckingConfiguration` (macOS 14+) [35] has `enableAdvancedDucking` and `duckingLevel` (`.default`, `.min`, `.mid`, `.max`). The default is advanced off, level `.default` [35]. Set `.min` so the user's music is not crushed while voice mode is open.
- **Other controls** (macOS 14+) [33][34]:
  - `isVoiceProcessingAGCEnabled`, `isVoiceProcessingBypassed` and `isVoiceProcessingInputMuted`.
  - `setMutedSpeechActivityEventListener`: it reports speech `started`/`ended` while the input is muted.
  - **Untested barge-in idea:** mute VPIO input while TTS plays and use the listener as the barge-in trigger, then unmute. Whether the detector runs on the echo-cancelled signal is **unverified**.
- **Residual echo:** VPIO has no tuning knobs. Developers report audible residual echo for 200–500 ms after playback stops. One report needed an 800 ms post-playback gate; 300 ms leaked TTS tails into transcripts [37].

### VAD options

| VAD | Licence | Size | Cost | Notes |
| --- | --- | --- | --- | --- |
| Psyche energy VAD (today) | ours | none | negligible | 0.9 s end-of-turn, 600 ms pre-roll on barge-in (`apps/web/src/shell/vad.ts`) |
| WebRTC VAD (libfvad [39]) | BSD-3-Clause | none (GMM, not a neural net) | ~2 µs per frame [40] | 10/20/30 ms frames at 8–48 kHz. High recall (0.98) but lower precision (0.82); flags chatter as speech [40]. |
| Silero VAD [38] | MIT, v6.2.3 (2026-09) | 1.2–1.3 MB (16 kHz ONNX) to 2.3 MB | <1 ms per 30+ ms chunk on one CPU thread | F1 0.94 vs 0.90 for WebRTC on one 30-file benchmark [40]. Needs ONNX Runtime; it is a neural model, so the same owner sign-off as §3 applies. |
| Apple `SpeechDetector` [2] | system | system | system | No speech events exposed. Not usable for turns. |
| VPIO muted-talker events [34] | system | system | system | Only while muted. Candidate barge-in trigger; untested. |

### Reliable barge-in on laptop speakers

1. **One echo-cancellation domain.** Capture and playback must sit under one canceller.
   - Renderer today: `getUserMedia({echoCancellation})` plus Web Audio playback, relying on Chromium's echo cancellation (see `psyche-today.md`).
   - Helper alternative: VPIO with TTS through an `AVAudioPlayerNode` on the same engine.
   - Never capture in one process and play in another without a shared reference.
2. **Raise the bar while speaking.** While TTS plays, require at least about 300 ms of continuous VAD-positive speech above a higher energy threshold. Then require one transcribed word that is not in the sentence being spoken; the volatile partials, at 0.3–1.0 s cadence, give this.
   - Stop TTS on the VAD trigger, and roll back (resume) if no confirming word arrives within about 1 s.
   - These thresholds are starting points and are **unverified**.
3. **Post-playback hold.** Ignore VAD for 500–800 ms after the last TTS buffer plays [37], and disarm the hold when new TTS audio starts.
4. **Headphones.** When the output route is headphones (`AVAudioSession` is not available on macOS; use the Core Audio default output device's transport type), drop the hold and the raised threshold.
5. **Fallback.** If echo leaks on a given Mac, fall back to half duplex: mute capture while speaking, and use a hotkey or click to interrupt. Expose this as a setting.

## 5. Microphone indicator and permissions on macOS

- **The indicator:** an orange dot by the Control Center icon "indicates the microphone on your Mac is in use". The top of Control Center lists which apps are using it [41]. In practice it stays on while any process holds an open input stream, whether a `MediaStream` track, an `AVAudioEngine` input or a VPIO unit, even if the app discards the audio.
- **Attribution:**
  - TCC charges a privacy access to the "responsible code" [43]. For a child process, that is the parent app; the README notes that a helper run from a shell is attributed to the terminal (spike 04).
  - Renderer capture in Electron runs in Chromium's audio-service utility process and is attributed to Psyche.app (its responsible app).
  - Psyche Helper (`com.psyche.helper`), launched through LaunchServices or launchd, is its own responsible app, so helper capture is attributed to "Psyche Helper".
  - Each bundle id needs its own Microphone grant and its own `NSMicrophoneUsageDescription`. A sandboxed or hardened app also needs `com.apple.security.device.audio-input`. A missing key makes the system terminate the app on first access [42].
- **Status APIs:**
  - `AVCaptureDevice.authorizationStatus(for: .audio)` (`.notDetermined` → `requestAccess(for: .audio)`) [42], or `AVAudioApplication.recordPermission` (macOS 14+) [44].
  - The helper already preflights with `AVCaptureDevice.authorizationStatus` and never reads `TCC.db`.
- **For voice mode:**
  - Capture stays in the renderer (default topology): one grant (Psyche.app), one name in Control Center, and the same echo-cancellation domain as playback.
  - If the helper captures (VPIO path), the user grants Microphone a second time, to Psyche Helper, and Control Center shows "Psyche Helper". The spec should pick one capture owner per mode and say which.

### Issue #611 and what it implies

- **The report:** #611 (closed 2026-10-26 UTC, completed): after dictation on the installed build (main 007a7633), the orange dot stayed on.
  - The issue listed three capture paths: the dictation HUD renderer (`getUserMedia` + `AudioContext`), the web composer mic (`voice.ts`) and the helper's `AVAudioEngine` tap, which looked correct.
  - It asked that every exit path stop tracks, close the `AudioContext` and disconnect nodes. Release, cancel, stray tap, toggle off, HUD hidden, blur and error are all exit paths.
  - It also asked for a 2 s watchdog and for a fresh capture per session rather than a warm one [45].
- **The fix, PR #613 (merged):**
  - **Cause:** the HUD's `Capture.start` awaited `getUserMedia` before recording how to stop. A stop that arrived during the await found nothing, and the late stream stayed open. A late start ack could also satisfy a stop.
  - **Generations:** each capture now has a generation, so a superseded start stops the tracks it receives.
  - **Release:** `release()` is idempotent. It stops tracks, disconnects nodes, closes the context, and also runs on `pagehide` and on unmount.
  - **Acks:** acks carry `{id, ok, open}`. Main force-releases (destroys the HUD window) if a stop is not confirmed within 2 s or is confirmed with `open: true`.
  - **Composer:** `voice.ts` releases the stream if `AudioContext` setup throws.
  - **Not yet verified:** the PR tested exit paths with fakes (19 tests). The dot itself was not checked after a real dictation; that waits for the next installed build [45].
- **Implications for voice mode:**
  - Voice mode holds the mic far longer than dictation, so the same rules apply more strictly:
    - one capture owner, with a generation per session;
    - an idempotent release on end, error, hang-up, window close, sleep and route change;
    - a confirmed `open: false` after stop, and a watchdog that force-releases.
  - Do not keep a warm capture between conversations to save startup time. The indicator would stay on, and that is exactly the #611 symptom.
  - Add a manual check to the test plan: the orange dot and the Control Center list are clear within 2 s of ending a conversation, after each exit path.
  - A wake word or "always listening" mode would make the dot permanent by design. That is another reason it stays off by default.

## What Psyche already has

- **Helper speech sources:** `apps/mac-helper/Sources/PsycheHelperSystem/Speech/` contains seven files:
  - `SpeechAnalyzerEngine.swift`: SpeechAnalyzer engine, with `SpeechTranscriber` or `DictationTranscriber` chosen by vocabulary, locale resolution, and `AssetInventory` installs with `speech.model_download` events.
  - `SFSpeechEngine.swift`: on-device `SFSpeechRecognizer` fallback for macOS 15 and unsupported locales.
  - `SpeechAudioSources.swift`: `MicrophoneSource` (`AVAudioEngine` tap, 2048 frames, `stop()` removes the tap and stops the engine; no voice processing) and `PushSource` for pushed PCM.
  - `SpeechAudioBuffers.swift`: PCM conversion and copying.
  - `SpeechTranscription.swift`: stream orchestration and permission preflight.
  - `SpeechSynthesis.swift`: `AVSpeechSynthesizer.write` on the main actor, voice resolution and the Personal Voice gate.
  - `SpeechCapabilities.swift`: the capability schemas.
- **Capabilities** (helper README "Speech (Q1)"):
  - `speech.transcribe_stream`:
    - `source` is microphone or push; also `locale?` and `vocabulary?` (≤ 100 × 64 chars).
    - Push format is s16le/f32le, 8–48 kHz, 1–2 channels.
    - `maxDurationMs` defaults to 5 min.
    - Events: `speech.started`, `speech.partial`, `speech.final`.
    - The result carries `firstResultMs` and `stopReason`.
  - `speech.audio_push`: ≤ 512 KiB per chunk, 8 MiB buffer.
  - `speech.stop`.
  - `speech.synthesize`:
    - `text` ≤ 5000 chars, plus `voice?`, `rate?`, `personalVoice` (opt-in) and `format`.
    - Streams `speech.audio` chunks of ≤ 64 KiB.
    - The result has `nonCommercial: true` for Personal Voice.
  - `speech.voices` and `speech.status`.
  - Limits: one microphone stream at a time, at most 4 streams.
- **Measured** (spike 03, `docs/spikes/spike-03-speechanalyzer.md`, M5, macOS 27.0.1):
  - First correct partial: 0.61 s (`SpeechTranscriber`) and 0.82 s (`DictationTranscriber` + vocabulary).
  - Final after end of input: 0.08–0.19 s and 0.27–0.55 s.
  - WER: 5.3% and 3.0–3.4%.
  - Parakeet TDT v2 for macOS 14–15: 0.75 s first partial, 0.10–0.25 s final, 4.2% WER, 443 MB download.
  - No engine met the "< 500 ms first partial" target. Spike 03 proposed 700 ms from speech onset to first partial, and 500 ms from key-up to final.
- **Gaps for voice mode:**
  - No voice processing (VPIO) anywhere in the helper.
  - No use of `SpeechDetector`, `progressiveShortDictation` or a custom language model.
  - TTS is synthesized whole per `speech.synthesize` call. Sentence-level streaming from the reply is the caller's job.
  - No real-microphone latency or barge-in measurement yet.

## Sources

1. Apple, WWDC25 session 277, "Bring advanced speech-to-text to your app with SpeechAnalyzer". https://developer.apple.com/videos/play/wwdc2025/277/
2. Apple Developer Documentation, `SpeechDetector`. https://developer.apple.com/documentation/speech/speechdetector
3. Apple Developer Documentation, `SpeechTranscriber.Preset`. https://developer.apple.com/documentation/speech/speechtranscriber/preset
4. Apple Developer Documentation, `DictationTranscriber`. https://developer.apple.com/documentation/speech/dictationtranscriber
5. Apple Developer Documentation, `DictationTranscriber.Preset`. https://developer.apple.com/documentation/speech/dictationtranscriber/preset
6. Apple Developer Documentation, `AnalysisContext`. https://developer.apple.com/documentation/speech/analysiscontext
7. Apple Developer Documentation, `AssetInventory`. https://developer.apple.com/documentation/speech/assetinventory
8. Apple Developer Documentation, `SpeechTranscriber`. https://developer.apple.com/documentation/speech/speechtranscriber
9. Apple Developer Documentation, "Speech updates" (June 2026). https://developer.apple.com/documentation/updates/speech
10. Apple Developer Documentation, `CaptureInputSequenceProvider` (macOS 27+). https://developer.apple.com/documentation/speech/captureinputsequenceprovider
11. Apple Developer Documentation, `AnalyzerInputConverter` (macOS 27+). https://developer.apple.com/documentation/speech/analyzerinputconverter
12. Apple sample code, "Recognizing speech in live audio" (iOS/macOS 27). https://developer.apple.com/documentation/speech/recognizing-speech-in-live-audio
13. Apple Developer Documentation, `AVSpeechSynthesisVoiceQuality`. https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoicequality
14. Apple Developer Documentation, `AVSpeechSynthesizer.write(_:toBufferCallback:)`. https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/write(_:tobuffercallback:)
15. Apple Developer Documentation, `AVSpeechUtterance.init(ssmlRepresentation:)`. https://developer.apple.com/documentation/avfaudio/avspeechutterance/init(ssmlrepresentation:)
16. Apple, WWDC20 session 10022, "Create a seamless speech experience in your apps" (Siri voices not available through the API). https://developer.apple.com/videos/play/wwdc2020/10022/
17. Apple, WWDC23 session 10033, "Extend Speech Synthesis with personal and custom voices". https://developer.apple.com/videos/play/wwdc2023/10033/
18. Apple Developer Documentation, `requestPersonalVoiceAuthorization(completionHandler:)`. https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/requestpersonalvoiceauthorization(completionhandler:)
19. Apple, Software License Agreement for macOS Tahoe 26, §2.F "Voices; Live Captions". https://www.apple.com/legal/sla/docs/macOSTahoe.pdf
20. Ben Dodson, "Using your Personal Voice in an iOS app" (2024): enhanced/premium voice sizes, the "Allow Apps to Request to Use" switch, status values. https://bendodson.com/weblog/2024/04/03/using-your-personal-voice-in-an-ios-app/
21. Apple Support, "Change the voice your Mac uses to speak text". https://support.apple.com/guide/mac-help/change-the-voice-your-mac-uses-to-speak-text-mchlp2290/mac
22. Apple Developer Forums, "AVSpeechSynthesizer system voices (SLA clarification)" (community answer, not Apple). https://developer.apple.com/forums/thread/812285
23. openWakeWord (README; release v0.5.1 assets for sizes). https://github.com/dscripka/openWakeWord and https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1
24. microWakeWord and the ESPHome model repository. https://github.com/kahrendt/microWakeWord and https://github.com/esphome/micro-wake-word-models
25. Picovoice Porcupine repository. https://github.com/Picovoice/porcupine
26. Picovoice, General FAQ ("no dedicated free or paid plans for personal or non-commercial use"). https://picovoice.ai/docs/faq/general/
27. Home Assistant Community, "Picovoice confirmed Free Tier AccessKeys will stop working after June 30, 2026" (quotes Picovoice support; secondary). https://community.home-assistant.io/t/fyi-picovoice-confirmed-free-tier-accesskeys-will-stop-working-after-june-30-2026/1012744
28. KITT.AI, Snowboy README (shutdown notice). https://github.com/Kitt-AI/snowboy
29. Mycroft Precise repository, and Wikipedia, "Mycroft (software)". https://github.com/MycroftAI/mycroft-precise and https://en.wikipedia.org/wiki/Mycroft_(software)
30. Apple Developer Documentation, `SNClassifySoundRequest`. https://developer.apple.com/documentation/soundanalysis/snclassifysoundrequest
31. Apple, WWDC21 session 10036, "Discover built-in sound classification in SoundAnalysis". https://developer.apple.com/videos/play/wwdc2021/10036/
32. Apple, WWDC19 session 510, "What's New in AVAudioEngine" (voice processing mode). https://developer.apple.com/videos/play/wwdc2019/510/
33. Apple, WWDC23 session 10235, "What's new in voice processing" (macOS 14 ducking, muted talker detection). https://developer.apple.com/videos/play/wwdc2023/10235/
34. Apple Developer Documentation, `AVAudioInputNode` (voice-processing properties). https://developer.apple.com/documentation/avfaudio/avaudioinputnode
35. Apple Developer Documentation, `voiceProcessingOtherAudioDuckingConfiguration` (macOS 14+). https://developer.apple.com/documentation/avfaudio/avaudioinputnode/voiceprocessingotheraudioduckingconfiguration
36. Apple Developer Forums, "MacOS echo cancellation (AUVoiceProcessing) trouble with device gain/volume" (Apple engineer reply). https://developer.apple.com/forums/thread/733733
37. Barock, "Why your iOS voice agent still hears itself" (2026-04-22; field report, iOS, not a controlled benchmark). https://barock.dev/2026/04/22/why-your-ios-voice-agent-still-hears-itself
38. Silero VAD repository (MIT; model files in `src/silero_vad/data`). https://github.com/snakers4/silero-vad
39. libfvad (WebRTC VAD as a standalone library, BSD-3-Clause). https://github.com/dpirch/libfvad
40. wavekat-vad 0.1.17 documentation (WebRTC vs Silero benchmark; one dataset). https://docs.rs/crate/wavekat-vad/0.1.17
41. Apple Support, "Use Control Center on Mac". https://support.apple.com/guide/mac-help/mchl50f94f8f/mac
42. Apple Developer Documentation, "Requesting authorization to capture and save media". https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media
43. Apple Developer Forums, "Device Authorization in a C-Tool" (Quinn: TCC finds the "responsible code"). https://developer.apple.com/forums/thread/701094
44. Apple Developer Documentation, `AVAudioApplication.recordPermission` (macOS 14+). https://developer.apple.com/documentation/avfaudio/avaudioapplication/recordpermission-swift.property
45. Psyche issue #611 and PR #613. https://github.com/devmello/psyche/issues/611 and https://github.com/devmello/psyche/pull/613
46. Apple Developer Documentation, "App Shortcuts" (App Intents). https://developer.apple.com/documentation/appintents/app-shortcuts
