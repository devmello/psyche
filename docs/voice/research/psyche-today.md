# What Psyche has for voice today (code audit, main at 41009f99, 2026-10-25)

Read from the code, not from the docs. Paths are relative to the repository root.

## Answers for the spec

- The pieces for a conversation mode exist, but the shipped app does not show voice mode. Composer dictation doesn't appear either. The composed app renders the UI kit's `ChatThread` and never passes it `onDictate`. The `VoiceMode` from #481 lives only in the shell's fallback `ChatView`, which the composed app no longer renders (§2).
- Audio is captured in the renderer, never in the helper's microphone path: the composer, voice mode and the system-dictation HUD all use `getUserMedia`. The Gateway's `voice.*` methods forward it to the helper's `speech.transcribe_stream` as pushed PCM.
- Synthesis renders PCM in the helper (`AVSpeechSynthesizer.write`) and plays it in the renderer through Web Audio. Chromium echo-cancels audio a page plays through an `AudioContext` when "Chrome-wide echo cancellation" is on. That is a feature-flag default from Chromium 111 on Mac, Windows and Linux [1], and Electron 44 ships Chromium 152. So keeping capture and playback in the same renderer is what makes barge-in work on laptop speakers. It must be verified in the dev run, because a flag default can change.
- Replies are read whole, after the run ends (`speech.readAloud {save: false}`). Nothing synthesizes while the model streams, so the first audio comes only after the full answer. That is the largest latency cost today.
- The helper's hold-key watch follows one key at a time (`dictation.watch`: "a newer watch … ends this one"). A voice hotkey alongside the dictation key needs a helper change.
- The model router streams text and tool events only. There is no audio or realtime surface in `ModelProvider`.

## 1. Inventory

| Layer | What exists | Where |
| --- | --- | --- |
| Helper STT | `speech.transcribe_stream` (microphone or `source: push`, `vocabulary` → DictationTranscriber + `contextualStrings` on macOS 26+, SpeechTranscriber without, SFSpeechRecognizer fallback), `speech.audio_push`, `speech.stop`, `speech.status` | `apps/mac-helper/Sources/PsycheHelperSystem/Speech/` |
| Helper TTS | `speech.synthesize` (AVSpeechSynthesizer `write`, ≤ 5 000 chars, `rate`, Personal Voice only with `personalVoice: true`, result flags `nonCommercial`), `speech.voices` (`quality`, `personalVoice`) | `SpeechSynthesis.swift`, `SpeechCapabilities.swift` |
| Helper keys and insertion | `dictation.watch` (fn / Right Option / Right Command hold, one key), `dictation.target`, `dictation.insert` | `Dictation/DictationCapabilities.swift` |
| Gateway speech | engine selection (Mac node → whisper.cpp → Web Speech), `voice.start/push/stop/cancel`, `voice.memo.save`, `speech.readAloud` (`save`, cancel), `speech.voices`, custom vocabulary from IDENTITY.md / USER.md / contacts | `packages/speech`, mounted by `apps/gateway/src/compose/speech.ts` |
| Cloud TTS | OpenAI `gpt-4o-mini-tts` and ElevenLabs `eleven_flash_v2_5`, keys from the vault, used only when the owner names them | `packages/speech/src/engines/cloud.ts` |
| Desktop system dictation | hold-to-talk or toggle hotkey, HUD window capturing the mic, text inserted into the focused app, never into a thread | `apps/desktop/src/main/dictation/` (J9, Q2) |
| Voice mode (Q5, #481) | `VoiceMode`: listening → thinking → speaking with an energy VAD (0.9 s end-of-turn), barge-in with 600 ms pre-roll, Gateway or browser voice, a "Needs your approval on screen" wait. It never answers approvals. | `apps/web/src/shell/voice-mode.ts`, `vad.ts`, `components/VoiceModeBar.tsx` |
| Settings | Voice & dictation: push-to-talk key, mode, system-wide, hotkey, engine; Voice mode group (`voice.conversation.enabled/start/reply/bargeIn`) | `packages/ui/src/screens/settings/VoiceSection.tsx` |
| Microphone release | every exit path releases the capture (#611, closed by c84dd785) | desktop dictation |
| Avatar and lantern | `AvatarState` idle / working / needs-you / error / paused / incognito / offline. The lantern glow exists only in the startup splash (`.startup-splash-lantern`, `psy-lantern` 2.8 s). | `packages/ui/src/avatar/Avatar.tsx`, `packages/ui/src/styles/design.css` |
| Languages | UI catalogues: en plus ar, de, es, fr, hi, it, ja, ko, pt, zh; `ui.language` picks the catalogue | `packages/ui/src/i18n/` |
| Proactive | Daily brief as a system `briefing` automation (07:00 default); heartbeat check-ins (O2); `morning-brief` skill planned in #641 | `packages/proactive/src/feed/service.ts` |

## 2. The gap in the shipped app

`apps/web/src/compose/PsycheApp.tsx` passes `chat: (threadId, ctx) => <KitChat …/>` to `ShellApp`. `KitChat` renders `ChatThread` from `@psyche/ui` without `onDictate`, and `UiSlots` has no voice slot. `ShellApp` only renders its own `ChatView`, the one with the mic button and `useVoiceMode`, when no `chat` slot is given (tests and fallbacks). In the desktop and web app today:

- the composer has no dictation button;
- the Voice mode settings group exists but nothing reads it.

The code for both runs in tests. The fix is to move the controller behind a kit slot (or into the kit) and mount it in `KitChat`.

## 3. The audio path today

```
renderer (composer / HUD)
  getUserMedia {echoCancellation, noiseSuppression} → 16 kHz s16le, 100 ms chunks
    → voice.push → Gateway VoiceSessionManager → NodeSpeechEngine
      → helper speech.transcribe_stream {source: push} → speech.partial / speech.final
    ← voice.segment events (to the starting device only)
reply: speech.readAloud {messageId, save: false} → helper speech.synthesize → PCM
    ← speech.audio events → renderer Web Audio playback
```

Measured (spike 03, M5, macOS 27):

| Measure | Value |
| --- | --- |
| First correct partial | 0.6–0.8 s after speech onset |
| Final after key-up | 0.1–0.6 s |
| DictationTranscriber with vocabulary, WER | 3.0–3.4 % |
| Helper synthesis, first audio (cold, S14 bench) | ≈ 0.8 s |

## Sources

1. Zoom Developer Forum, "isSupportChromeWideAEC() sniffs browser name + version" (2025): playback through an `AudioContext` is echo-cancellable only because of Chromium's Chrome-wide echo cancellation, a feature-flag default; Zoom's SDK assumes it from Chrome 111 on Mac/Windows/Linux. https://devforum.zoom.us/t/issupportchromewideaec-sniffs-browser-name-version-breaking-echo-cancellation-on-microsoft-edge/145288 (secondary source; verify in the dev run)
2. W3C webrtc-logs, 2019: Chrome then cancelled only WebRTC peer audio, unlike Firefox and Safari. https://lists.w3.org/Archives/Public/public-webrtc-logs/2019Apr/0334.html
3. Chrome Developers, "macOS native echo cancellation" (M66–M68): with the `echoCancellation` constraint Chrome uses hardware or its software canceller. https://developer.chrome.com/blog/macos-native-echo-cancellation
4. `docs/archive/spikes-docs/spike-03-speechanalyzer.md` (this repo).
