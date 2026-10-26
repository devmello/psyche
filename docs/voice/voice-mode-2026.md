# Voice mode 2026: specification and plan

**Owner:** S17 (speech). **Status:** spec, 2026-10-25. **Issues:** epic #696; V-G #691, V-H #692, V-U #693; bug #690. **Asked by:** the owner ("full voice mode would be cool too").

Research behind this plan, with sources:
- [research/apple-on-device-speech.md](research/apple-on-device-speech.md): SpeechAnalyzer and SpeechDetector, AVSpeechSynthesizer voices and Personal Voice, wake-word options, voice processing and echo, the microphone indicator.
- [research/cloud-voice-apis.md](research/cloud-voice-apis.md): realtime speech-to-speech APIs, cloud TTS and STT, cascaded versus speech-to-speech, latency budgets, cost.
- [research/voice-ux-landscape.md](research/voice-ux-landscape.md): how ChatGPT, Gemini Live, Siri, Claude and Sesame handle turn-taking, interruptions, feedback and actions by voice.
- [research/psyche-today.md](research/psyche-today.md): what the code has today, the audio path, and the gap in the shipped app.

The short version: Psyche can already transcribe on the Mac, speak with the system voice and run a basic listen–think–speak loop. But the shipped app shows none of it, and replies are spoken only after the whole answer exists. This plan moves the conversation into a Gateway-owned session that streams the reply sentence by sentence while the model writes. Push-to-talk on a hotkey is the default, with tap-to-talk and hands-free as options, and approvals can be answered by voice within chat's tiers. The lantern becomes the voice's face. Three workstreams carry it: helper (Swift), Gateway, and UI.

## 1. Where we are (main, 2026-10-25)

From [research/psyche-today.md](research/psyche-today.md):

| Piece | State |
| --- | --- |
| On-device STT | `speech.transcribe_stream` in the helper: DictationTranscriber with contextual strings on macOS 26+ (3.0–3.4 % WER), SpeechTranscriber without, SFSpeechRecognizer before 26. First partial 0.6–0.8 s, final 0.1–0.6 s after key-up (spike 03). |
| On-device TTS | `speech.synthesize` (AVSpeechSynthesizer `write`, PCM back to the Gateway); Personal Voice only on opt-in, flagged non-commercial |
| Gateway | `voice.*` dictation sessions, `speech.readAloud {save: false}` with cancel, `speech.voices`, custom vocabulary, engine selection, cloud TTS (OpenAI, ElevenLabs) only when named |
| Clients | Composer dictation and Q5 voice mode (#481) are built in the shell's `ChatView`. System dictation (hold fn, HUD) is in the desktop. |
| **Gap** | **The shipped app renders the kit's `ChatThread`, which gets neither dictation nor voice mode.** The Voice mode settings exist, but nothing reads them. |
| Latency | A reply is read only after the run ends, so the first audio waits for the whole answer |
| Router | Text and tools only; no audio models |
| Look | The lantern glow exists only in the startup splash; the avatar has no listening or speaking state |

## 2. What the research says (summary)

- **Apple's stack is enough for a cascade** ([apple-on-device-speech.md](research/apple-on-device-speech.md)).
  - SpeechAnalyzer runs on device with no Speech Recognition permission. DictationTranscriber with contextual strings had the best accuracy (3.0–3.4 % WER), and `progressiveShortDictation` is the unmeasured preset meant for short turns.
  - Apple's `SpeechDetector` reports no speech start or end, so Psyche keeps its own VAD.
  - AVSpeechSynthesizer streams PCM (about 0.8 s to first audio, cold). Siri voices are off-limits, premium voices need a user download, and Personal Voice is "personal, non-commercial use" only.
- **No wake word comes free.** Apple gives none to apps. Porcupine now needs a paid key. openWakeWord's models are non-commercial. microWakeWord (52–60 KB, Apache-2.0) is the only clean option, and it is still a local model under the owner's rule.
- **Echo** is the main cause of false barge-in on a Mac: ChatGPT's Mac app interrupted itself on built-in speakers in 2025 ([voice-ux-landscape.md](research/voice-ux-landscape.md) §7.7). Capture and playback must share one echo canceller. In Psyche that is the renderer, because Chromium cancels page-played audio ([psyche-today.md](research/psyche-today.md)).
- **There is no Anthropic voice API**; Claude takes text and images in and gives text out. So using Claude by voice means the cascade is ours.
- **Speech-to-speech APIs** (OpenAI `gpt-realtime-2.1`, GPT-Live, Gemini 3.8 Live) support tools and barge-in. They measure 0.7–1.35 s to first audio and cost $0.45–3 per 10 minutes. They also send the owner's voice off the Mac and put a vendor's model in charge of the turn ([cloud-voice-apis.md](research/cloud-voice-apis.md) §1, §6).
- **A tuned cascade is competitive:** about 0.7–1.2 s to first audio with sentence-level TTS and thinking off, and $0.15–0.45 per 10 minutes with on-device STT ([cloud-voice-apis.md](research/cloud-voice-apis.md) §5–§6).
- **OpenAI's TTS endpoints shut down on 2027-01-06**, so Psyche's OpenAI cloud voice must go. ElevenLabs Flash v2.5 ($0.04 per 1K characters, 100–150 ms to first byte) is the cloud voice to keep.
- **Products converge on the same patterns** ([voice-ux-landscape.md](research/voice-ux-landscape.md)):
  - voice inside the chat with a live transcript (ChatGPT since November 2025);
  - read back and ask once before consequential actions (Siri, Google, OpenAI guidance);
  - one or two spoken sentences, with the rest on screen;
  - a one-line preamble only for slow tools;
  - separate "mute" and "stop speaking" controls;
  - a visual driven by audio level, with a reduced-motion form.
  The most common complaint everywhere is being cut off at a pause. Several products default to hands-free. Psyche defaults to push-to-talk, as this plan's brief asks, which also avoids that failure.

## 3. Decisions

1. **Cascaded, on-device by default.** STT runs in the helper and the answer comes from Psyche's own agent loop through the router, so tools, memory, approvals, taint and receipts stay exactly as in chat. TTS runs in the helper too. Speech-to-speech APIs (OpenAI Realtime, Gemini Live) are not used in this plan. They would replace the agent loop with a vendor's model, send the owner's audio off the Mac and bill per minute (§9 lists them as a later, opt-in experiment).
2. **The Gateway owns the conversation.** A new `VoiceConversation` in `packages/speech` runs the turns. Clients become audio terminals: they capture, play, detect barge-in and draw. The in-app overlay, the global HUD and the web client then behave the same, and the reply can be synthesized while the model streams.
3. **Push-to-talk is the default.** Hold a key from any app (default Right ⌘, distinct from the dictation key), or tap Voice in the composer. Hands-free (end of turn by pause, barge-in) is an option. A wake word is not built in this plan (§4.4).
4. **Speak for the ear, show for the eye.** Voice turns ask the model to lead with a short spoken answer. By default Psyche speaks that lead and says the rest is on screen. Code, tables and links are never read aloud.
5. **Approvals by voice follow chat's tiers.** Voice may answer `write` and `destructive` approvals after a fixed readback, with a fixed phrase list. `deviceOnly` kinds (purchases, credential fills, host shell, policy and pairing) always need the card and Touch ID. The setting defaults to writes only. This replaces #481's rule that voice never answers approvals, at the owner's request ("yes, send it").
6. **Capture and playback stay in the renderer.** Chromium's echo canceller then knows what is playing, which is what makes barge-in work on laptop speakers ([psyche-today.md](research/psyche-today.md) §Answers). The helper does not play audio in this plan. For the same reason, #481's browser voice (`speechSynthesis`, played by the system rather than the page) is removed. The reply is always PCM from the Gateway: the helper's voice on a Mac, or Kokoro or a named cloud voice in server mode.
7. **Honest microphone.** The microphone is open only while the owner holds the key, plus a 250 ms tail, or for the hands-free session, which ends after 30 s without speech. The overlay always shows whether the mic is on, and it matches the macOS indicator (#611).
   - **One process captures in every mode:** the renderer, which macOS attributes to Psyche.app, both in the app and in the HUD. The helper never opens the microphone for conversation.
   - Capture is never kept warm between conversations, and every ending releases it, as #613 does for dictation.

## 4. Design

### 4.1 Modes

| Mode | Start | End of the owner's turn | Barge-in | Microphone open |
| --- | --- | --- | --- | --- |
| **Push-to-talk** (default) | Hold the voice key from any app, or hold the overlay's mic | Key up | Pressing the key again while Psyche speaks | Only while held, plus 250 ms |
| **Tap-to-talk** | Tap Voice in the composer, or tap the voice key | A pause (endpointing, §4.3) or a second tap | Talking, or tapping | From tap to end of turn; again for each turn after a reply |
| **Hands-free** | Tap Voice, then keep talking turn after turn | A pause | Talking over the reply | For the whole conversation; ends after 30 s of silence, on End, or on screen lock |
| **Wake word** | Not in this plan | — | — | — |

A conversation belongs to one thread. In-app it uses the open thread. From the global hotkey it uses the main thread, unless the owner held the key while a side chat was frontmost in Psyche.

### 4.2 The pipeline

```
renderer (overlay or HUD)                         Gateway: VoiceConversation                 helper
  getUserMedia {echoCancellation} 16 kHz  ──audio──▶  STT session (voice.* engine)  ──push──▶  speech.transcribe_stream
  client VAD (barge-in only)                         endpointing (VAD + engine finals)       (DictationTranscriber +
  Web Audio playback  ◀──audio── sentence TTS ◀───── agent loop (voice turn, router)          contextual strings)
  level meter → lantern                              │  chat.delta → sentence splitter
                                                     │  tool calls → narration
                                                     └  approvals → readback + phrase match
                                                     TTS: helper speech.synthesize per sentence ──▶ AVSpeechSynthesizer
                                                          (or a named cloud voice)
```

- **Turns start through the agent loop like chat messages.** The owner's words become a normal user message: `owner` provenance, plus a `via: "voice"` marker on the message. The turn starts with `StartTurnInput.voice = {speak, narrate}`, so agent-core adds a short "voice turn" section to the system prompt (§4.5).
- **Sentence TTS.** The Gateway splits the streaming answer at sentence ends (≥ 40 characters or a hard stop), synthesizes each sentence as soon as it is complete, and streams PCM to the client. The next sentence synthesizes while the current one plays. The helper keeps the synthesizer warm for the conversation's voice.
- **What was heard.** The client reports how much of each spoken utterance it played (`played`). When the owner barges in, the Gateway knows exactly what they heard, cuts the spoken caption there, and starts the next turn. The message on screen stays complete.
- **Barge-in** is detected in the client, where the echo canceller is. While audio plays, the client requires about 300 ms of speech above the stricter #481 profile. The Gateway then confirms it with one transcribed word that is not in the sentence being spoken. For 500–800 ms after the last buffer plays, the VAD is ignored, because echo tails leak past 300 ms ([apple-on-device-speech.md](research/apple-on-device-speech.md) §4).
  - **Two steps, so it feels instant but is not fooled by echo.** On 300 ms of speech the client ducks the reply to 30 % volume and sends `interrupt {stage: "suspect"}`. When the Gateway's STT returns a word that is not in the sentence being spoken, the Gateway confirms: the client stops playback, synthesis stops and the owner's turn opens. With no such word within 1 s, the volume comes back.
  - **Push-to-talk** barge-in is the key itself: pressing it stops playback at once, with no confirmation.
  - **The run** keeps going, unless the owner says "stop", which cancels it.

### 4.3 Endpointing (when the owner has finished)

- Push-to-talk: key up, nothing else.
- Tap-to-talk and hands-free: the turn ends after **600 ms** of silence following speech, measured by Psyche's own VAD on the Gateway's PCM. Apple's `SpeechDetector` can't do this: its results report only errors, not speech start or end ([apple-on-device-speech.md](research/apple-on-device-speech.md) §1). If the energy VAD proves too weak, WebRTC VAD (BSD-3-Clause, not a neural network) is the next step. Silero VAD (MIT, 1.2–2.3 MB) would count as a local model under the owner's rule.
  - **Trailing words.** If the final text ends in a conjunction or filler ("and", "but", "so", "um"; one list per locale in the catalogue), the hangover extends to 1.2 s. Products that reply after a bare 300–500 ms of silence are the ones reviewers say cut them off ([voice-ux-landscape.md](research/voice-ux-landscape.md) §7.7).
  - **Floor.** A turn shorter than 300 ms of speech is ignored (coughs, doors).
- An earcon (a soft 60 ms tick) and the lantern change mark "heard you" within 100 ms of end-of-turn. The owner knows Psyche got it before any words come back.

### 4.4 Wake word

Not built in this plan. Apple gives third-party apps no wake word. Every local option keeps the microphone open all the time, which keeps the orange indicator on. Each also needs a keyword-spotting model running continuously ([apple-on-device-speech.md](research/apple-on-device-speech.md) §3).

- **Options.**
  - Porcupine is out: it needs an access key checked at start-up, and its free tier ended on 2026-06-30.
  - openWakeWord: Apache-2.0 code, but its pre-trained models are CC BY-NC-SA 4.0, about 2.6–4.1 MB per word.
  - microWakeWord: Apache-2.0, 52–60 KB models.
  - Apple's Sound Analysis could be trained on a phrase, but it is built for sound events and its accuracy on speech is unverified.
- **The owner's rule.** A keyword spotter is a small audio classifier, not a language model, so it doesn't break the intent of the no-local-LLM rule. But the rule's text covers "any other local model", so adding one needs the owner's explicit yes (§11).
- **Cost.** Always-on listening keeps the orange indicator on permanently and the audio path running.

If the owner wants it later, it is an opt-in hands-free start behind its own switch, with the indicator on whenever it listens. It gets its own issue.

### 4.5 What Psyche says

| Setting | Spoken | On screen |
| --- | --- | --- |
| **Brief** (default) | The spoken lead (≤ 2–3 sentences, about 60 words), then "The rest is on screen" when more follows | The full answer |
| **Full** | The whole answer, flattened, up to 2 000 characters, then "The rest is on screen" | The full answer |

**The voice-turn prompt section** (agent-core, ≤ 400 characters, per locale) tells the model:
- start with a direct spoken answer in plain sentences, with no lists, no Markdown and no URLs in that lead;
- put details after a blank line;
- for a question it can't answer yet, say what it is doing in one short sentence;
- never say something is done before the tool reports success (the reply after a write waits for the receipt).

**The speakable filter** (`markdownToSpeech`, already in `packages/speech`):
- code blocks, tables and URLs are never spoken; "I've put the link on screen" replaces a URL;
- numbers and dates are read as written;
- untrusted quoted content is spoken only as part of the agent's own sentences, never as markup (SSML is stripped).

**Narration of tool steps** (`voice.conversation.narrate`):

| Level | What is spoken |
| --- | --- |
| Off | Nothing |
| **Brief** (default) | One short phrase when a step runs longer than 1.5 s ("Checking your calendar.") |
| Every step | Each step's one-line label |

- The phrases come from the tool's `describeCall().summary` / `level1` label, rendered by a template. They are not model text, so injected content can't choose what Psyche says.
- Labels carrying third-party text (subjects, page titles) are cut to the verb and the app.

### 4.6 Approvals by voice

The tiers are chat's (security §3.7, §9):
- `write` and `destructive` approvals can be answered by voice;
- `deviceOnly` kinds (`financial`, `credential_fill`, `exec_host`, `policy`, `pairing`) never can.

The setting `voice.conversation.approvals` takes:
- `off`;
- **`write`** (default);
- `write_destructive`.

**Flow**, for the approval that a voice turn's run is waiting on:

1. **Readback.** The Gateway speaks a fixed template filled from the ApprovalRequest, never from model text: the action, the target and the binding fields. For example: "Send an email to alice@example.org, subject 'Running late'. Say 'send it' or 'cancel'." The card shows at the same time.
2. **Listening window.** The window opens only after the readback has finished playing, so Psyche can't hear itself, and lasts 10 s.
3. **Phrase match.** The owner's final transcript is matched, after normalisation, against a fixed phrase list per locale in the catalogue:
   - approve: "yes", "send it", "do it", "go ahead", "approve";
   - deny: "no", "cancel", "don't", "stop", "deny".
   Anything else, or silence: "I'll leave it on screen." The card stays and nothing is decided.
4. **Answer.** On a match the Gateway calls the broker's answer path with this device's surface token, scope `once` only, and `via: "voice"`. The audit entry records the voice surface and a hash of the utterance, and the receipt says "approved by voice".

**Never by voice:**
- grant scopes wider than `once`;
- approvals in a turn tainted by untrusted content: voice can deny, but approving needs the card;
- `deviceOnly` kinds, where Psyche says "That needs your Touch ID on screen".

**Questions (`ask_user`).** A single-choice question is read with its options, and a spoken option label answers it (fuzzy match, confirmed by readback). Free-text questions take the next utterance as the answer. Multi-select questions stay on screen.

### 4.7 Privacy

- **Audio stays on the Mac** by default:
  - STT is SpeechAnalyzer in the helper, TTS is AVSpeechSynthesizer;
  - audio is never written to disk, except voice memos the owner saves;
  - transcripts are ordinary messages, so they follow the thread's retention and incognito rules.
- **Cloud voices are opt-in and labelled.** Settings names the vendor and says that Psyche's replies go to it as text: "Sends replies to ElevenLabs." Keys come from the vault. This plan offers no cloud STT and no speech-to-speech.
- **Speaking aloud is a disclosure.** Spoken replies can be overheard. The spoken brief and check-ins (§4.9) never play while the screen is locked or a Focus mode is on, and they are off by default.
- **The microphone** follows decision 7. Hands-free ends after 30 s of silence and on screen lock, sleep, a Psyche window losing its last connection, or the Gateway restarting.

### 4.8 Languages

- **Language.** The conversation's language follows `ui.language` unless `voice.conversation.language` overrides it. English plus the ten catalogues: ar, de, es, fr, hi, it, ja, ko, pt, zh.
- **STT.** It uses that locale when SpeechAnalyzer supports it (SpeechTranscriber listed 45 locales and DictationTranscriber 54 on the spike Mac; assets for a new locale download through `AssetInventory`, fr-FR in 17 s, and an app can reserve at most 5 locales). Otherwise it falls back to the Mac's dictation locale and says so in the overlay.
- **TTS.** It picks the best installed voice for the locale (premium, then enhanced, then default) unless the owner chose one. Settings links to System Settings → Accessibility → Spoken Content to download premium voices.
- **Strings.** The readback templates, the approval phrases, the trailing-word lists and the narration templates live in the UI catalogues, translated per locale. Arabic captions run right to left.

### 4.9 Spoken brief and check-ins

- **Daily brief.**
  - The brief's notification gains **Listen**. It opens the HUD and speaks a script of at most 90 s, written for the ear by the brief job with the voice-turn rules, then hands over to a push-to-talk conversation ("Ask me about any of these").
  - "Speak the brief when I'm at the Mac" (off by default) plays it the first time the owner unlocks the Mac after the brief's time, unless a call or a Focus mode is active.
- **Check-ins.** Heartbeat check-ins (O2) and goal check-ins (O9) gain Listen on their notification. They are never spoken unprompted.

### 4.10 Accessibility

- **Captions** are on by default, and the transcript is always in the thread. Everything spoken is also visible.
- **VoiceOver.**
  - State changes are announced through a polite live region ("Listening", "Thinking", "Speaking").
  - While Psyche speaks, the caption isn't also announced, so it isn't spoken twice.
  - When VoiceOver is running, Psyche ducks its speech whenever VoiceOver speaks (Electron `app.accessibilitySupportEnabled`).
- **Keyboard.**
  - The voice key works from anywhere.
  - In the overlay, Space holds to talk, Esc ends the conversation and ⌘. stops speaking.
- **Reduced motion.** The lantern doesn't scale or follow levels. It shows three still states, and the state is written next to it.
- **Speech differences.** "Review before sending" (off by default) shows the transcript for editing before it goes out, in all modes. The hands-free hangover can be lengthened (`voice.conversation.pauseMs`, 500–2 000).

## 5. Latency budget

Target: the first audio of the reply **within 1 s of the end of the owner's turn** for a short answer with push-to-talk, and about 1.5 s hands-free, where the pause itself takes 0.6 s. The earcon and lantern change ("heard you") come within 100 ms.

| Stage | Push-to-talk | Hands-free | Evidence |
| --- | --- | --- | --- |
| End of turn | 0 (key up) | 600 ms (1.2 s after an unfinished phrase) | §4.3 |
| STT final | 100–300 ms | 100–300 ms | spike 03: 0.1–0.6 s after input ends; the short preset is unmeasured (V-H H3) |
| Model first token | 250–400 ms | 250–400 ms | fast model, cached prompt, thinking off; an assumption to measure per router target ([cloud-voice-apis.md](research/cloud-voice-apis.md) §5) |
| First speakable sentence | 50–150 ms | 50–150 ms | 10–20 tokens at 100–230 tokens/s |
| TTS first audio | 100–200 ms warm (target) | same | AVSpeechSynthesizer measured 0.8 s **cold**: V-H H2 must keep it warm. ElevenLabs Flash 100–150 ms over the network |
| Playback start | 20–50 ms | 20–50 ms | first 100 ms PCM chunk |
| **Total** | **≈ 0.5–1.1 s** | **≈ 1.1–1.7 s** | Products measure 0.7–1.35 s ([cloud-voice-apis.md](research/cloud-voice-apis.md) §5) |

- **The largest risk is the cold synthesizer.** Without H2 the on-device voice adds about 0.6 s to every first sentence.
- **Dead air.** If 1.5 s pass without audio, the lantern keeps its thinking pulse and a soft cue plays once, because silence reads as failure (Alexa+ took up to 10 s on old devices).

Measures that buy the budget:
- push-to-talk ends the turn with no hangover;
- a new `voice` model role (beside the router's `primary`, `utility`, `embedding`, `vision` and `speech`; it picks the chat model for voice turns, while `speech` stays the audio model role) points at a fast model. It defaults to the primary model, and the owner can pick a faster one in Settings → Models;
- the first sentence is synthesized while the model writes the second;
- the synthesizer is kept warm per conversation;
- the client plays the first PCM chunk on arrival (100 ms chunks).

The Gateway records each turn's timings (`voice.turn.timing` in the log, no content): end of turn → final transcript → first token → first sentence → first audio sent. A dev-run report checks them against this table.

## 6. UX

### 6.1 In the app: the voice capsule

- **Morph.** Starting a conversation morphs the composer capsule (redesign §5.2, glass refraction) into the voice capsule. It is the same size and position, uses `layoutId` on `spring.smooth`, and becomes a crossfade under reduced motion. The thread stays visible above it.
- **Inside the capsule:**
  - the **lantern** (40 px avatar with its glow, §6.3);
  - **one caption line** (the owner's partial words in `--label-secondary` while listening, then Psyche's current sentence while speaking);
  - the **step line** while it works ("Checking your calendar", with the status glyph);
  - the **controls**: hold-to-talk (or the mode's tap control), "Mute" (hands-free: the mic closes and the dot goes off, while the conversation stays), "Stop speaking" while it speaks, and End. Mute and Stop speaking are separate and instant, as in the products reviewed.
- **Mic state.** It sits on the trailing edge, "Mic on" with a dot, and always matches the real capture.
- **Messages.** A spoken message shows a small waveform glyph by its time. Psyche's reply message renders as usual; the spoken part is the first paragraph, marked by a thin accent rule while it is being spoken.
- **Approvals.** The card renders in the approval dock as always. During the readback the capsule shows "Say 'send it' or 'cancel'", and a 10 s ring drains on the lantern.

### 6.2 Outside the app: the voice HUD

Holding the voice key while another app is frontmost opens a floating HUD:
- top-centre, 380 × 96 pt, the same capsule and material;
- it uses the existing dictation HUD window machinery;
- it follows the conversation and closes 4 s after the last reply;
- clicking it opens the thread in Psyche.

The global hotkey never takes text from the focused app. That remains system dictation's job, on its own key.

### 6.3 The lantern

The moth's lantern from the app icon and splash becomes the voice's face. It is a radial accent glow behind the avatar, driven by audio levels the client measures itself (RMS of the capture and of the playback, 30 Hz, smoothed with 80 ms attack and 250 ms release):

| State | Glow |
| --- | --- |
| Listening, quiet | steady, 35 % opacity |
| Listening, owner speaking | scale 1.00–1.12 and opacity 35–85 % with the input level |
| Heard you | one 120 ms brighten (with the earcon) |
| Thinking | the shared working pulse (1.2 s, motion.md §4.6) |
| Speaking | follows the output level, warmer (accent-10) |
| Needs you (approval) | still, accent ring draining over the 10 s window |
| Mic off / ended | fades out in 280 ms |

Reduced motion: no scale and no level following. Three still opacities (listening, thinking, speaking), with the state as text. The glow is CSS (`opacity`, `transform` on one layer), within motion.md §5's budget, and it stops when the conversation ends (WCAG 2.2.2).

### 6.4 Settings → Voice & dictation → Voice conversation

| Row | Control | Default |
| --- | --- | --- |
| Talk with Psyche | switch | off |
| Voice key | key picker (fn / Right ⌥ / Right ⌘), must differ from the dictation key | Right ⌘ |
| How turns end | Push to talk / Tap to talk / Hands-free | Push to talk |
| Voice | the voice catalogue (`speech.voices`) with quality labels; "Get better voices…" opens Spoken Content; Personal Voice switch with Apple's terms line; cloud voices with their label | best installed for the language |
| Speed | 0.8× – 1.5× slider | 1.0× |
| Spoken replies | Brief / Full | Brief |
| Say what it's doing | Off / Brief / Every step | Brief |
| Interrupt by talking | switch | on |
| Approve by voice | Off / Writes only / Writes and deletes ("Purchases, passwords and security changes always need the card") | Writes only |
| Language | Follow app language / list | follow |
| Captions | switch | on |
| Review before sending | switch | off |
| Spoken brief | Off / On Listen / When I'm at the Mac | On Listen |

These replace the Q5 group from #481. The existing keys migrate: `voice.conversation.start` toggle becomes hands-free and push stays push. `voice.conversation.reply` is dropped (decision 6).

### 6.5 Onboarding

The last onboarding step gains one line when the helper is connected: "Hold Right ⌘ to talk to Wren." No permission is asked there. The microphone prompt comes on first use, after a one-line pre-prompt in the capsule ("Psyche needs the microphone to hear you").

## 7. Protocol (V-G's first PR)

Additive. The method names below are the contract the other workstreams build against.

| Method / event | Shape | Notes |
| --- | --- | --- |
| `voice.conversation.start` | `{threadId?, mode: "push" \| "tap" \| "handsfree", format, language?, voice?}` → `{conversationId, engine, location}` | `operator.write`; one per device |
| `voice.conversation.audio` | `{conversationId, seq, audio}` → `{}` | mic PCM, as `voice.push` |
| `voice.conversation.turn` | `{conversationId, action: "begin" \| "end"}` → `{}` | push-to-talk key down / up, tap |
| `voice.conversation.interrupt` | `{conversationId, stage: "suspect" \| "confirmed", playedMs?}` → `{}` | barge-in: `suspect` from the client VAD (ducked), `confirmed` from a key press; the Gateway confirms a suspect with a transcribed word (event `voice.conversation.state` `phase: "listening"`) or releases it |
| `voice.conversation.played` | `{conversationId, utteranceId, playedMs, done}` → `{}` | what the owner heard |
| `voice.conversation.stop` | `{conversationId}` → `OkResult` | ends; mic off |
| event `voice.conversation.state` | `{conversationId, phase: "listening" \| "heard" \| "thinking" \| "speaking" \| "waiting" \| "ended", reason?, approvalId?}` | to the starting device |
| event `voice.conversation.caption` | `{conversationId, role: "owner" \| "agent", utteranceId, text, final}` | |
| event `voice.conversation.speech` | `{conversationId, utteranceId, seq, audio, format, last}` | PCM for playback |
| event `voice.conversation.step` | `{conversationId, toolCallId, label, status}` | narration text as shown |
| event `voice.conversation.ended` | `{conversationId, reason: "stopped" \| "idle" \| "locked" \| "error" \| "disconnected", error?}` | |
| `ApprovalAnswer.via` | optional `"voice"` | audit and receipt |
| `Message.via` | optional `"voice"` | the waveform glyph |
| `StartTurnInput.voice` | optional `{speak: "brief" \| "full", narrate}` | the voice-turn prompt section |
| `PickableModelRole`, `ModelRoles` | gain `voice` (optional) | Settings → Models; the router's `MODEL_ROLES` gains `voice` |
| Settings keys | `voice.conversation.{enabled, key, mode, voice, rate, speak, narrate, bargeIn, approvals, language, captions, reviewBeforeSend, pauseMs, brief}` | documented in `setting-labels.ts` |

The helper additions are in V-H's brief.

## 8. Plan: three workstreams

**Order:**
1. V-G's protocol PR (G0) first.
2. Then three tracks in parallel, against fakes and fixtures:
   - V-H, queued behind the connectors helper session (#638): it starts when that session's last wave-1 PR merges or the integrator frees the Swift slot;
   - V-G's conversation PRs;
   - V-U's first PR. It fixes the shipped-app gap, so it can merge on its own.
3. The rest of V-U follows V-G's G1.
4. One announced dev run at the end, with the owner present, because it puts the microphone prompt on screen.

**Every PR:**
- **Tests** use fixtures only: fake audio frames, `FakeNodeClient` for the helper, scripted model streams for the agent loop. No microphone and no speakers in CI.
- **Checks:** vitest with `--maxWorkers=1`, and typecheck only the changed packages.
- **Dev runs:** at most one announced run for the whole plan, with `PSYCHE_HOME=~/.psyche-try PSYCHE_PORT=7989`, never the owner's installed app or `~/.psyche`.
- **Swift:** one build at a time on this machine.

### V-G: Gateway voice conversation (TypeScript; one session)

- **Owns:**
  - `packages/protocol` (the G0 PR only);
  - `packages/speech/src/conversation/**` and the speech handlers;
  - `apps/gateway/src/compose/speech.ts`;
  - the voice-turn section in `packages/agent-core/src/context.ts`;
  - the `voice` model role in `packages/model-router` config;
  - `apps/desktop/src/main/voice/**` (global key and HUD window);
  - the brief's Listen action in `packages/proactive`.
- **PRs:**
  - **G0:** the protocol of §7.
  - **G1:** `VoiceConversation` covering turns, endpointing, sentence TTS, `played`, barge-in and the state and caption events, with the handlers and the Gateway mount.
  - **G2:** voice turns, i.e. `StartTurnInput.voice` and the agent-core prompt section; narration from tool labels; the `voice` role. Voice turns run with thinking off, or `between_tools` where a model can't turn it off, because reasoning adds seconds before the first word.
  - **G3:** approvals and questions by voice (§4.6).
  - **G4:** desktop main: the voice key through the helper watch, the HUD window, lock/sleep/disconnect endings. Plus the spoken brief and check-ins (§4.9).
- **Definition of done:**
  - Fixture tests for every phase transition.
  - Sentence splitting on streamed deltas, including code blocks and URLs that are never spoken.
  - Barge-in mid-sentence with correct `played` truncation.
  - The approval readback is built from the request's fields only.
  - Phrase matching in every catalogue locale.
  - `deviceOnly`, tainted and wider-than-`once` approvals are refused by voice.
  - Idle and lock endings.
  - The timing log line, on fake clocks.
- **Brief:**
  > You own the Gateway side of Psyche's voice conversation. Read docs/voice/voice-mode-2026.md in full (§3–§5, §7) and its research files, plus `packages/speech/README.md` and `apps/web/src/shell/voice-mode.ts` (the #481 client loop you are replacing).
  >
  > First, open the protocol PR for §7, additively: `voice.conversation.*` methods and events, `ApprovalAnswer.via`, `Message.via`, `StartTurnInput.voice`, plus the settings keys in the setting labels. Add a CHANGES.md entry and a changeset, update the fakes, run `pnpm protocol:gen`, and title it `protocol: voice conversation (part of #691)`.
  >
  > Then build `VoiceConversation` in `packages/speech/src/conversation/`:
  > - **Turns.** It reuses the dictation engine (`SpeechEngineSelector`, the custom vocabulary) for each turn and endpoints as §4.3 says.
  > - **Starting a turn.** It sends the owner's words through the Gateway's chat path as a `via: "voice"` owner message, with `StartTurnInput.voice`.
  > - **Speaking.** It splits the streaming answer into sentences, keeps only the spoken part per `speak` (§4.5), and synthesizes each sentence with the selected engine (helper `speech.synthesize`, or a cloud voice only when named). It streams `voice.conversation.speech` to the starting device only, tracks `played`, and stops at once on `interrupt`.
  > - **Narration** comes from tool-call labels through templates (never model text).
  > - **Approvals and questions by voice:** exactly §4.6. The readback is built from the ApprovalRequest; the phrase lists come from the UI catalogues (ask V-U for the keys); answers go through the broker with the device's surface token, scope `once`, `via: "voice"`. Refuse `deviceOnly`, tainted approves and any wider scope.
  > - **Endings:** the conversation ends on stop, after 30 s idle, on lock or sleep (desktop main reports these), on disconnect and on Gateway shutdown, and the mic-on state goes false on every path.
  >
  > Mount the handlers through `SPEECH_METHODS` in `apps/gateway/src/compose/speech.ts`.
  >
  > In agent-core, add the voice-turn section of §4.5 (≤ 400 characters, per locale) when `StartTurnInput.voice` is set. In the router config, add a `voice` model role that defaults to the primary model.
  >
  > In `apps/desktop/src/main/voice/`, add:
  > - the voice key through the helper's watch (V-H adds a second key; until it lands, use the existing single-key watch when the dictation key is off);
  > - a HUD window like the dictation HUD, loading the renderer entry V-U provides;
  > - lock, sleep and disconnect reporting.
  >
  > Add Listen to the daily brief and check-in notifications (§4.9).
  >
  > Cloud voices: OpenAI's `gpt-4o-mini-tts` shuts down on 2027-01-06 (docs/voice/research/cloud-voice-apis.md §2). Remove the `openai` voice from `CloudTtsEngine` and the catalogue, migrating an owner who chose it to the default voice with a notice. Keep ElevenLabs, and use its streaming WebSocket so the first byte arrives in 100–150 ms.
  >
  > Tests are fixtures only: fake PCM, `FakeNodeClient`, scripted model streams, fake clocks, `--maxWorkers=1`. Typecheck only the packages you change. No microphone, no local models, no Ollama. Title PRs `feat(speech): voice conversation <part> (part of #691)`.

### V-H: helper speech for conversation (Swift; one session, after the connectors helper wave)

- **Owns:**
  - `apps/mac-helper/Sources/PsycheHelperSystem/{Speech,Dictation}/**`;
  - their tests and the README speech section;
  - `apps/mac-helper/docs/manual-test-plan.md` rows.
- **PRs:**
  - **H1:** two watched keys. `dictation.watch` takes optional `keys: [{key, role: "dictation" | "voice"}]` and events carry `role`. The old single `key` keeps working.
  - **H2:** faster synthesis.
    - `speech.prepare {voice, language}` keeps a synthesizer warm and pre-renders a silent utterance.
    - `speech.synthesize` gains `rate` mapping for 0.8–1.5× and `utteranceId` in its events.
    - `speech.voices` reports `quality`, `language` and `installed`.
    - A first-audio timing appears in `speech.status`.
  - **H3:** short turns. `speech.transcribe_stream` takes `preset: "shortDictation"` to use DictationTranscriber's `progressiveShortDictation` (meant for about a minute of live audio, frequent finalization). Report its first-partial and finalize times in `speech.status` beside the long preset's. Spike 03 never measured it.
  - **H4:** Personal Voice authorization on request (`speech.personal_voice.authorize`), never prompted without an owner action.
- **Definition of done:**
  - Each PR has fake-backend tests and Core unit tests.
  - A manual-test-plan row.
  - The README table.
  - One `swift build --build-tests`, then filtered `swift test`.
  - No microphone in tests.
- **Brief:**
  > You own the Mac helper's speech for Psyche's voice conversation. Read docs/voice/voice-mode-2026.md (§3, §4.2–§4.4, §4.8, §7) and docs/voice/research/apple-on-device-speech.md.
  >
  > In `apps/mac-helper/Sources/PsycheHelperSystem/{Speech,Dictation}`, implement, one PR each and in this order, H1 two-key watch, H2 synthesis latency, H3 the short-dictation preset and H4 Personal Voice authorization, exactly as the spec's V-H list says. The capability shapes come from V-G's protocol PR. Keep every existing capability working: `dictation.watch {key}` and `speech.synthesize` without the new fields.
  >
  > Rules:
  > - Never play audio from the helper; the renderer plays.
  > - Never capture the microphone for conversation; the renderer captures.
  > - Never prompt for Personal Voice without an explicit call.
  >
  > Each PR has a fake-backend test, Core unit tests for pure logic, a manual-test-plan row and the README table. One `swift build --build-tests` per PR, then `swift test --skip-build --filter <your suites>`; one Swift build at a time on this machine. No microphone or speaker in tests. At most one announced dev run with `PSYCHE_HOME=~/.psyche-try PSYCHE_PORT=7989`. Title PRs `feat(helper): <part> for voice conversation (part of #692)`.

### V-U: voice UI (TypeScript; one session)

- **Owns:**
  - `packages/ui/src/voice/**` (new: capsule, lantern, captions, step line, HUD view);
  - the voice hooks in `packages/ui/src/chat/Composer.tsx` and `Thread.tsx`;
  - `KitChat` in `apps/web/src/compose/PsycheApp.tsx`;
  - `apps/web/src/shell/{voice-mode.ts,vad.ts,voice.ts}`, which become the audio terminal;
  - the desktop renderer entry for the HUD;
  - `packages/ui/src/screens/settings/VoiceSection.tsx`;
  - the onboarding line;
  - the voice strings in every catalogue.
- **PRs:**
  - **U1 (first; fixes #690):** composer dictation and the #481 voice mode in the kit's `ChatThread`, through a `voice` slot that `KitChat` fills. It ships before anything else.
  - **U2:** the voice capsule, the lantern and captions, against V-G's events on the MockGateway. The shell client becomes the audio terminal (capture, VAD barge-in, playback with `played` reports, levels).
  - **U3:** the HUD view and renderer entry; the approval readback state; the Settings group of §6.4 with migration of the Q5 keys; the onboarding line.
  - **U4:** strings and phrase lists in all ten catalogues; RTL captions; the accessibility items of §4.10.
- **Definition of done:**
  - MockGateway tests for every phase.
  - Lantern stories in each state, light and dark, with a reduced-motion story where nothing animates a `transform`.
  - Axe on the capsule and HUD.
  - The mic-on chip always matches capture in tests.
  - `pnpm i18n:check` clean.
- **Brief:**
  > You own Psyche's voice UI. Read docs/voice/voice-mode-2026.md (§1, §4.1, §4.6, §4.10, §6) and docs/design/redesign-2026.md (§3.4 materials, §5.2 composer) with docs/design/motion.md.
  >
  > **First PR (#690):** the shipped app renders the kit's `ChatThread`, which has neither composer dictation nor the #481 voice mode. Add a `voice` slot to `UiSlots` (or a kit hook) so `KitChat` in `apps/web/src/compose/PsycheApp.tsx` gets the composer mic and the Voice button. Prove it with a test on the composed app, then ship it alone.
  >
  > **Then build `packages/ui/src/voice/`:**
  > - the voice capsule that the composer morphs into (`layoutId`, `spring.smooth`, glass refraction, crossfade under reduced motion);
  > - the lantern behind the 40 px avatar, driven by input and output RMS at 30 Hz as §6.3's table says;
  > - one caption line, the step line, the controls and the mic-on chip;
  > - the approval readback state, with its 10 s ring.
  >
  > Turn `apps/web/src/shell/voice-mode.ts` into the audio terminal for V-G's `voice.conversation.*` events:
  > - capture with echo cancellation;
  > - the barge-in VAD;
  > - Web Audio playback with `played` reports;
  > - the level meter.
  >
  > Then:
  > - the HUD view and the desktop renderer entry the V-G HUD window loads;
  > - the Settings group of §6.4, replacing the Q5 group and migrating its keys;
  > - the onboarding line;
  > - every string, readback template, approval phrase list and trailing-word list in all ten catalogues and English;
  > - RTL captions for Arabic;
  > - the accessibility items of §4.10.
  >
  > Tests run on the MockGateway with fake audio, `vitest --maxWorkers=1` for packages/ui and apps/web only. Typecheck only those. No Electron e2e, no microphone, no local models. Title PRs `feat(ui): voice <part> (part of #693)`.

### What each workstream proves before its last PR merges

| Workstream | Proof |
| --- | --- |
| V-G | protocol check clean; fixture tests of §8's V-G list; the timing log on fake clocks |
| V-H | fake-backend tests per PR; existing capabilities unchanged; manual test rows |
| V-U | U1 test on the composed app; MockGateway phase tests; lantern stories incl. reduced motion; axe; i18n check |
| All | one announced dev run with the owner: push-to-talk turn, hands-free turn, barge-in on laptop speakers, a voice-approved email draft, mic indicator off after each ending; timings against §5 |

## 9. Later (not in this plan)

- **Speech-to-speech "fast voice"** (OpenAI Realtime, Gemini Live) as an opt-in experiment for chit-chat. It would hand off to the agent loop for anything that needs tools, memory or approvals. Audio leaves the Mac, and it is billed per minute ([cloud-voice-apis.md](research/cloud-voice-apis.md)).
- **Wake word** (§4.4).
- **Cloud STT** for languages SpeechAnalyzer lacks.
- **Voice on channels** (calling Psyche from a phone).
- **Speaker identification**, to refuse voice approvals from other voices.

## 10. Risks

- **Microphone indicator correctness (#611).** A capture path left open keeps the orange dot on after a conversation. Every ending path releases capture, and tests assert the mic-on chip and the capture state together. The dev run checks the real indicator after each ending.
- **Echo and false barge-in.** Laptop speakers feed the reply back into the mic. Mitigations:
  - capture and playback stay in one renderer, so Chromium's canceller sees the reply;
  - the stricter barge-in profile;
  - "Interrupt by talking" can be turned off;
  - #481's browser voice is removed (decision 6), so every reply is page-played PCM.
  If the dev run shows Chromium's canceller off in Electron, barge-in defaults to off on speakers and on with headphones.
- **Cutting the owner off at pauses.** A 500 ms endpoint is fast but cuts slow speakers off. This is handled by the trailing-word extension, the `pauseMs` setting and push-to-talk as the default.
- **Voice approvals overheard or replayed.** A TV or another person could say "send it". The mitigations:
  - writes only by default;
  - the listening window opens only after the readback, and lasts 10 s;
  - fixed phrases;
  - `deviceOnly` exclusions;
  - no approving in tainted turns;
  - receipts say "by voice".
  Speaker identification is later (§9).
- **Cost.** On-device STT and TTS are free. Each voice turn is a normal model turn, so a 10-minute conversation costs like 10–20 chat turns on the `voice` role's model ($0.15–0.45 per 10 minutes on cloud models, against $0.45–3 for speech-to-speech APIs, [cloud-voice-apis.md](research/cloud-voice-apis.md) §6). Cloud voices bill per character. The usage screen shows voice turns separately.
- **Latency on older Macs.** The spike measured an M5. M1-class Macs will be slower ([apple-on-device-speech.md](research/apple-on-device-speech.md)), so the timing log reports real numbers and the brief default stays short.
- **Vendor churn.** OpenAI's TTS endpoints and the original `gpt-realtime` shut down in January 2027. V-G removes the OpenAI cloud voice, and nothing in this plan depends on a speech-to-speech API.
- **Scope creep.** Wake word, speech-to-speech and channel calls stay out of these PRs (§9).

## 11. Decisions the owner should confirm

**Decided 2026-10-26** (relayed by the integrator):
1. No wake word in this plan. The hook stays, so a keyword spotter can be added later behind a setting.
2. "Writes only" stays the default for approving by voice.
3. The spoken brief defaults to "On Listen". Onboarding offers "When I'm at the Mac" as a choice, not the default.
4. Right ⌘ is the voice key.
5. The `voice` role defaults to the primary model. Onboarding shows the faster option with its one-line trade-off, not pre-selected.

The questions as they were asked:

1. **Wake word.** Not built (§4.4). A keyword spotter (microWakeWord, 52–60 KB, Apache-2.0) is not a language model, but the rule's text says "any other local model". Yes or no?
2. **Approve by voice.** Default "Writes only". Should "Writes and deletes" be the default for an owner who mostly uses voice? Security §16 item 6 is still open for chat as well.
3. **Spoken brief.** Default "On Listen", which never speaks unprompted. "When I'm at the Mac" speaks the brief at the first unlock after its time. Should that be the default?
4. **The voice key.** Right ⌘ by default, so it doesn't collide with dictation's fn. Is there another preference?
5. **The `voice` model role.** It defaults to the primary model. A faster model (a Haiku-class or Flash-class one) gets closer to the 1 s target but answers less well. Should onboarding suggest one?
