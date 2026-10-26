# Cloud voice APIs: speech-to-speech, TTS, STT, latency and cost

Research for the voice conversation mode spec. Researched 2026-10-25. Prices are list prices in USD read from vendor pages on that date unless marked otherwise. "Unverified" means I could not confirm the claim from a primary source.

## Answers for the spec

1. Default to a cascaded pipeline: on-device STT, then our own LLM through the model router, then streaming TTS. It is the only design that keeps Psyche's tool approvals, model choice and transcripts under our control. Anthropic has no public speech or realtime API: current Claude models take text and image input and produce text only [23].
2. Target 800 ms p50 and 1.2 s p95 from end of user speech to first audio. The budget is about 300 ms endpointing, under 100 ms STT finalize, about 300 ms LLM time to first token, about 100 ms for the first clause, about 100 ms TTS first byte and about 30 ms playback (table below). Measured speech-to-speech products land at 0.7–1.35 s time to first audio [45], so a well-tuned cascade is competitive with them.
3. Speak sentence by sentence (clause by clause for the first chunk) while the LLM streams. Use a TTS WebSocket that accepts streamed text input. ElevenLabs Flash v2.5 (about 75 ms model time, 100–150 ms TTFB in North America and Europe [32]) and Cartesia Sonic-3.6 (vendor claims under 90 ms [35]) both qualify.
4. Default cloud TTS: ElevenLabs Flash v2.5 at $0.04 per 1K characters [31], or Cartesia Sonic-3.6 at about $0.04–0.065 per 1K characters depending on plan [33]. A 10-minute conversation costs about $0.10–0.20 in TTS. Do not build on OpenAI `gpt-4o-mini-tts`, `tts-1` or `tts-1-hd`. They shut down on 2027-01-06, and OpenAI's suggested replacement is a Realtime model, not a TTS endpoint [5][11].
5. Speech-to-speech is an optional provider, not the core. OpenAI's `gpt-realtime-2.1` and Gemini's `gemini-3.8-live` both support function calling and barge-in. OpenAI's GPT-Live (`gpt-live-1`, $0.05/min) can hand reasoning and tools to a client-run backend, which is the only S2S option that could keep our own agent in the loop [6][7].
6. Rough cost of a 10-minute conversation: cascaded with local STT, $0.15–0.45. GPT-Live voice charges, $0.50 plus our LLM. Gemini 3.8 Live, $0.50–0.80. `gpt-realtime-2.1`, $0.45–1.10 with good caching and up to about $3 without it (table below).
7. Audio leaves the machine in every cloud S2S option and in cloud STT. With on-device STT and cloud TTS, only the assistant's text leaves for synthesis. The user's voice stays local, which is the privacy default to ship.

## 1. Speech-to-speech and realtime APIs

### 1.1 OpenAI Realtime API (`gpt-realtime-2.1` family)

- **Models.** Current models on the pricing page are `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime-2`, `gpt-realtime-1.5`, `gpt-realtime-mini` and `gpt-realtime` [1]. OpenAI's Realtime guide uses `gpt-realtime-2.1` in its code [3]. `gpt-realtime-2` launched 2026-05-07 with a 128K context (up from 32K), adjustable reasoning effort, spoken "preambles" while working, and parallel tool calls [12]. `gpt-realtime-2.1` and `-2.1-mini` followed on 2026-07-06. Reported changes are better alphanumerics, noise handling and interruption behaviour, plus a p95 latency cut of at least 25% (secondary source; OpenAI's post not fetched) [13]. The original `gpt-realtime` (2025-08-28 snapshot) shuts down 2027-01-20 [5].
- **Transports.** WebRTC (browser or client, via `/v1/realtime/calls`) and WebSocket (server) [3]. GPT-Live (below) adds SIP/telephony and a server-side "sideband" WebSocket [6].
- **Turn detection.** `session.audio.input.turn_detection` takes `server_vad` (silence-based, the default for speech-to-speech) or `semantic_vad` [2]. `server_vad` exposes `threshold` (0–1), `prefix_padding_ms` and `silence_duration_ms`. The guide's sample uses 0.5, 300 ms and 500 ms but does not state defaults [2]. `semantic_vad` scores whether the words form a complete utterance. Its `eagerness` is `low`, `medium`, `high` or `auto` (= `medium`), and it changes the maximum wait timeout. The guide gives no millisecond values [2]. Both modes accept `create_response` and `interrupt_response` (conversation sessions only) [2]. With `interrupt_response: true`, server VAD cancels the in-flight response when the user starts speaking. The client must then stop local playback and truncate the assistant item to what was actually played. The current VAD guide does not document that truncation flow, so check the API reference before implementing it (unverified detail).
- **Function calling.** Supported in-session. The Agents SDK `RealtimeAgent` adds tools, handoffs, guardrails and MCP servers [3]. OpenAI's prompting guide says to summarise a write action and "not call the tool until the user clearly confirms". It also says not to require confirmation for read-only lookups [10].
- **Pricing (per 1M tokens) [1].**

| Model | Audio in | Audio in (cached) | Audio out | Text in / out |
|---|---|---|---|---|
| gpt-realtime-2.1 | $32.00 | $0.40 | $64.00 | $4.00 / $24.00 |
| gpt-realtime-2.1-mini | $10.00 | $0.30 | $20.00 | $0.60 / $2.40 |
| gpt-realtime (legacy) | $32.00 | $0.40 | $64.00 | $4.00 / $16.00 |

- **Token accounting.** User audio is 1 token per 100 ms (about 600 per minute). Assistant audio is 1 token per 50 ms (about 1,200 per minute). VAD-filtered silence is not billed. The whole conversation is resent on every response, so later turns cost more. Caching is automatic but best effort and breaks if instructions or tools change mid-session [4].
- **Latency.** OpenAI publishes no millisecond figure for current models [3][4]. Artificial Analysis measures time to first audio at 1.21 s for `gpt-realtime-2.1` (High), 0.97 s (Minimal) and 0.85 s for the mini at Minimal [45]. For history: OpenAI's May 2024 GPT-4o launch claimed audio responses "in as little as 232 milliseconds, with an average of 320 milliseconds" [44].

### 1.2 OpenAI GPT-Live (`gpt-live-1`)

- A full-duplex voice model that "can listen while speaking". It hands harder work to a backend agent ("delegation") while it keeps talking [6]. It shipped in ChatGPT on 2026-07-08, with GPT-5.5 as the delegated backend there [14]. The API version is dated 2026-09-10 (from search snippets of OpenAI's post, which returned 403 to me) [9].
- **Delegation modes.** `responses`: OpenAI runs a Responses model as the backend and your app still runs function tools. `client`: you connect "any model, agent harness, or service your application runs" [6]. In client mode the app receives `session.delegation.created` (metadata only) plus input and output transcript deltas. It answers with `session.commentary.append` (text to be paraphrased aloud), `session.thinking.append` (silent facts) and `session.instructions.append`, each limited to 500 tokens [7].
- **Interruptions.** Interrupting the speech does not cancel backend work. The app must cancel it, confirm, and only then say so. Muting input does not stop the model talking; stop playback locally instead [7][8]. The docs place approvals and confirmations on the application side: "Report success only after the backend confirms it" [7].
- **Price.** $0.05 per minute, billed per second. Backend model and tool usage is billed separately. A WebRTC session bills 15 s at creation, credited against usage [1][4].
- **Latency.** Artificial Analysis: 1.24–1.34 s time to first audio, highest-tier index scores [45]. OpenAI publishes no figure [6].
- **Fit for Psyche.** Client delegation is architecturally interesting. GPT-Live would handle turn-taking and backchannels while our router and agent do the work. Costs: user audio goes to OpenAI; voice is fixed per session (default `marin`) [9]; spoken words are paraphrased by OpenAI's model, not taken verbatim from our LLM [7].

### 1.3 Google Gemini Live API

- **Models and prices (per 1M tokens) [15].** `gemini-3.8-live`, `gemini-3.8-live-extended-thinking` and `gemini-3.1-flash-live-preview` each cost $0.75 text in, $3.00 audio in (about $0.005/min), $4.50 text out and $12.00 audio out (about $0.018/min). `gemini-2.5-flash-native-audio-preview-12-2025`: $0.50 / $3.00 / $2.00 / $12.00. Audio is 25 tokens per second [15]. A Google billing reply quoted on the forum says 32 tokens/s and that silence is billed (unverified, not in docs).
- **Per-turn billing.** Google's Live API best-practices page says every turn bills all context tokens (history plus system instruction) [22]. Forum staff replies say Live models have no context caching (unverified). Long sessions therefore cost much more than the per-minute figures suggest.
- **`gemini-3.8-live`.** Listed as stable, updated September 2026. Context is 131,072 in and 65,536 out. Function calling is async by default (`NON_BLOCKING`), with `SILENT`, `WHEN_IDLE` and `INTERRUPT(ED)` scheduling of results. Also listed: search grounding, interleaved thinking, and proactive audio that is always on. Affective dialog has been removed [20]. In contrast, `gemini-3.1-flash-live-preview` supports only synchronous function calls, which pause the conversation until the result returns [19]. Google says Extended Thinking narrates progress while it reasons and runs tool calls in the background (secondary source) [21].
- **Turn detection.** `realtimeInputConfig.automaticActivityDetection` has `startOfSpeechSensitivity`, `endOfSpeechSensitivity`, `prefixPaddingMs` and `silenceDurationMs`. The default silence is about 800 ms and the recommended range is 500–800 ms. Automatic VAD can be disabled so the client sends `activityStart`/`activityEnd`. In a hybrid mode the client sends `audioStreamEnd` early [17].
- **Barge-in.** When VAD detects an interruption, generation "is canceled and discarded". The server sets `serverContent.interrupted`, and pending function calls are cancelled with their IDs reported [17]. Input and output transcription are available [17].
- **Transport and limits.** Stateful WebSocket. Audio in is 16 kHz 16-bit PCM and audio out is 24 kHz. Use ephemeral tokens for client connections [16]. Without compression, sessions last 15 min (audio) or 2 min (audio plus video). Connections last about 10 min, with `GoAway` warnings and resumption handles valid for 2 h [18].
- **Latency.** Artificial Analysis: 1.18 s time to first audio for `gemini-3.8-live` and 1.35 s for Extended Thinking (High) [45].

### 1.4 Anthropic

There is no public speech-to-speech, realtime or audio API. The models overview says all current models (Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5) "support text and image input, text output" [23]. Claude's consumer voice mode (mobile, desktop, web; beta) is an app feature, not an API [24]. Its speech synthesis reportedly comes from ElevenLabs, a subcontractor listed in Anthropic's terms [25]. To use Claude in voice, we have to build the cascade ourselves. One relevant latency control: Sonnet 5.5 does not allow `thinking: {type: "disabled"}`, but it does accept `between_tools`, which turns off up-front thinking [23]. Voice turns should use `between_tools` or a low effort setting to keep time to first token down.

### 1.5 Others, one line each

- **xAI Grok Voice.** Fastest measured S2S time to first audio: 0.70–0.81 s for Grok Voice 2.0 and 3.0, with the top index score for 3.0 [45]. I did not research its API terms.
- **Hume EVI.** A secondary source quoting Hume says the EVI and TTS APIs shut down 2026-11-13 [26]. Exclude it (unverified on Hume's own site).
- **Sesame CSM-1B.** Apache-2.0 [27]. A text-to-speech model (Llama backbone plus Mimi audio decoder) that "cannot generate text" and needs a separate LLM [27]. English-focused [27]. The card's examples pick CUDA when present and fall back to CPU; it states no hardware requirements, so treat Apple Silicon real-time performance as unverified. Sesame's own write-up says CSM does not model turn-taking, pauses or pacing [28].
- **Kyutai Moshi.** An open full-duplex model. The model card states 160 ms theoretical and 200 ms practical latency on an L4 GPU [29]. A useful reference point, but it is a separate local-model question.

## 2. Cloud TTS

| Provider / model | Latency claim | Streaming | Price |
|---|---|---|---|
| ElevenLabs Flash v2.5 | ~75 ms model time; 100–150 ms WebSocket TTFB in NA/EU/SEA, 150–200 ms S/NE Asia [30][32] | HTTP streaming and input-streaming WebSocket (`auto_mode`) [32] | $0.04 / 1K chars on every tier; plans $6–$990/mo include characters [31] |
| ElevenLabs Eleven v4 Turbo | ~100 ms median [30] | Text-to-Dialogue WebSocket [30] | v4/v3/Multilingual: $0.08 / 1K chars [31] |
| ElevenLabs v3 Conversational | ~280 ms [30] | WebSocket [30] | $0.08 / 1K chars [31] |
| Cartesia Sonic-3.6 (GA, snapshot `sonic-3.6-2026-08-27`, 44 languages) [34] | "under 90ms" vendor claim [35]; Sonic 3.5 measured at 128 ms median including network [36] | WebSocket (not re-verified on the 3.6 page) | 1 credit = 1 char; ~750–800 credits per audio minute. Pro $5/100K, Startup $49/1.25M, Scale $299/8M; overage $65–38 per 1M credits [33] |
| OpenAI `gpt-4o-mini-tts` | no figure [11] | chunked HTTP; `pcm`/`wav` fastest [11] | $0.60/1M text in, $12/1M audio out [1]. **Shuts down 2027-01-06** [5] |
| Google Gemini 3.8 Flash TTS | not checked | not checked | $0.50/1M text in, $9/1M audio out through 2026-12-31, doubling on 2027-01-01 [15] |
| Google Cloud TTS Chirp 3 HD | not checked | not checked | $30 / 1M chars after 1M free (from cached copies of the pricing page) [37] |
| Azure Neural TTS | not checked | not checked | ~$15 / 1M chars (HD ~$22) from a third-party calculator; Microsoft's page rendered no prices (unverified) [38] |

The OpenAI TTS guide recommends `marin` or `cedar` for quality and lists 13 voices. It suggests migrating to `gpt-realtime-2.1-mini`, which "isn't a supported model for `/v1/audio/speech`" [11]. OpenAI is effectively folding TTS into the Realtime API, so an OpenAI TTS adapter would need a Realtime connection used in text-in, audio-out mode. That is a heavier integration, and I have not verified its per-minute cost.

## 3. Cloud STT (for completeness)

- **Deepgram.** Nova-3 streaming $0.0048/min and Flux English $0.0065/min pay-as-you-go. These are marked "limited-time promotional rates" [39]. Flux has built-in end-of-turn detection: about 260 ms, `eot_threshold` default 0.7, and an optional `EagerEndOfTurn`/`TurnResumed` pair that Deepgram says adds 50–70% more LLM calls [40].
- **OpenAI.** `gpt-realtime-whisper` and `gpt-live-transcribe` cost $0.017/min for live use. `gpt-transcribe` costs $0.0045/min for files [1]. `gpt-4o-transcribe` shuts down 2027-02-26 [5].
- **AssemblyAI.** Universal-Streaming $0.15/h and Universal-3.6 Pro Realtime $0.45/h, billed on connection time, so idle open sockets cost money [41].
- **ElevenLabs Scribe v2 Realtime.** $0.39/h [31].

On-device STT is covered in the sibling Apple on-device speech research. Cloud STT should stay an opt-in fallback.

## 4. Cascaded vs speech-to-speech

| Concern | Cascaded (STT, our LLM, TTS) | Speech-to-speech (Realtime, Live, GPT-Live) |
|---|---|---|
| Latency | Sum of stages; 0.8–1.0 s reachable with streaming (section 5). A commentary cites ~1.7 s for older unoptimised cascades [14] | 0.7–1.35 s measured time to first audio [45]; better at overlap and backchannels |
| Model choice | Any router model, including local and Claude | Vendor's model only (GPT-Live client delegation is the partial exception [6]) |
| Tool use and approvals | Our existing tool runtime and approval UI apply unchanged | Tools run in the vendor session; approval gating must be rebuilt on vendor events. Gemini can cancel pending calls on barge-in [17] |
| Control over what is spoken | Exact: we speak the text our LLM produced and show the same text | Model-generated audio; transcripts are a separate ASR pass. GPT-Live paraphrases injected text [7] |
| Safety | Text can be checked before synthesis, for example to redact secrets or block reading out tokens | Harder to filter audio before it plays |
| Privacy | With on-device STT the user's voice never leaves the Mac; only reply text goes to TTS | Raw user audio streams to the vendor for the whole session |
| Cost | Mostly LLM tokens plus ~$0.04/1K chars TTS | Per-token audio pricing with context re-billing, or $0.05/min (GPT-Live) |
| Prosody and emotion | TTS cannot hear the user's tone | Native audio can react to tone and timing |

**How a cascade reaches conversational latency.** Do not wait for the full reply. Stream LLM tokens into a sentence (or clause) splitter and send each chunk to a TTS WebSocket as soon as it closes. Start playback on the first audio frame. ElevenLabs documents this pattern: its WebSocket "suits real-time text input such as LLM output", and with `auto_mode` disabled the model stalls until the chunk schedule fills [32]. Further techniques:

- **Speculative start.** Start the LLM call on an "eager" end-of-turn signal and cancel it if the user resumes. Flux exposes `EagerEndOfTurn`/`TurnResumed` [40]; OpenAI recommends speculative lookups from transcript fragments [4].
- **Keep the context stable** so the provider's prompt cache hits.
- **Make the first sentence short.** Instruct the model to lead with a short clause.
- **Speak a tool preamble** ("Checking your calendar.") while slow tools run, as OpenAI's realtime models now do by default [10].

## 5. Latency budgets

**Human baseline.** Across 10 languages, Stivers et al. (2009, PNAS) found turn transitions cluster near zero gap. Modal offsets were 0 to +200 ms per language; medians ran from 0 to +300 ms, with an overall median of about +100 ms [42]. Levinson and Torreira (2015) note that gaps of about 200 ms are much shorter than the ≥600 ms needed to plan even a one-word utterance. Humans therefore predict turn ends rather than react to silence [43]. A system that only reacts to silence cannot match 200 ms. Our realistic goal is to stay under the point where a pause reads as a problem.

**Acceptable assistant latency.** I found no peer-reviewed threshold for voice-assistant satisfaction. Vendor blogs commonly say 500–1,000 ms feels natural and above ~1.5 s feels broken, but they cite no studies (unverified). Measured reference points: speech-to-speech models at 0.70–1.35 s time to first audio [45]; GPT-4o's 2024 claim of 320 ms average [44]; ~1.7 s cited for older cascades [14].

**Budget for a cascaded pipeline, end of user speech to first audible sample:**

| Stage | Target (p50) | Evidence and notes |
|---|---|---|
| Endpointing (decide the user is done) | 250–350 ms | Silence VAD samples use 500 ms [2]; Gemini default ~800 ms, recommended 500–800 [17]; semantic end-of-turn ~260 ms (Flux) [40]. Use a semantic or eager detector plus a ~500 ms silence fallback |
| STT finalize | 50–100 ms | Streaming partials are already available; only the tail needs to settle (on-device, see sibling doc) |
| LLM time to first token | 250–400 ms | Assumption for a fast model with thinking off or `between_tools` [23] and a cached prompt; measure per router target. Reasoning modes add seconds |
| First speakable clause | 50–150 ms | ~10–20 tokens at ~100–230 tok/s; Haiku-class output speed measured at 234 tok/s [46] |
| TTS first byte | 75–150 ms | Flash v2.5 WebSocket 100–150 ms TTFB [32]; Sonic "under 90 ms" vendor [35], 128 ms measured for 3.5 [36] |
| Audio output buffer and device | 20–50 ms | Core Audio output buffer; keep the jitter buffer small for local playback |
| **Total** | **~700–1,200 ms** | Aim for 800 ms p50 and 1.2 s p95; play a soft "thinking" cue if 1.5 s passes with no audio |

Barge-in has its own budget. Stop playback within 100–200 ms of detected user speech, which requires local VAD on the echo-cancelled mic signal, not a server round trip.

## 6. Cost of a 10-minute conversation

Assumptions: 10 minutes wall clock, ~5 min of user speech, ~4 min of assistant speech (~3,200 characters, using Cartesia's 750–800 chars per minute [33]), 20 turns, and a 20K-token system prompt with tools. All figures are estimates.

| Option | Calculation | Estimate (10 min) |
|---|---|---|
| Cascade: on-device STT + Claude Haiku 5.5 + ElevenLabs Flash v2.5 | TTS 3.2K chars × $0.04 = $0.13; LLM ~0.5M input tokens mostly cached at "from $0.10/MTok" [23] ≈ <$0.05 | **~$0.15–0.20** |
| Cascade: on-device STT + Claude Sonnet 5.5 + Cartesia Sonic-3.6 | TTS $0.12–0.21 [33]; LLM $2/$10 per MTok with 5% cache reads [23] ≈ $0.10–0.25 | **~$0.25–0.45** |
| Cascade: same, plus cloud STT (Deepgram Nova-3, 10 min of connection) | +$0.05 [39] (AssemblyAI +$0.03 [41]; OpenAI realtime-whisper +$0.17 [1]) | +$0.03–0.17 |
| OpenAI `gpt-realtime-2.1` | Output 4,800 tok × $64/M = $0.31; new input 3,000 tok × $32/M = $0.10; ~80K re-sent context tokens: $0.03 if cached, $2.56 if not [1][4] | **~$0.45–1.10 cached; up to ~$3 uncached** |
| OpenAI `gpt-realtime-2.1-mini` | $0.10 out + $0.03 in + $0.02–0.80 context [1] | **~$0.15–0.95** |
| OpenAI GPT-Live (`gpt-live-1`) | 10 min × $0.05 [1]; backend LLM extra (ours, if client delegation) | **$0.50 + LLM** |
| Gemini 3.8 Live | Per-turn re-billing of ~14–21K accumulated audio tokens over 20 turns ≈ 140–220K × $3/M, plus 6K out × $12/M [15][22] | **~$0.50–0.80** |
| Vendor agent bundles, for reference | ElevenLabs Agents $0.08/min [31]; Deepgram Voice Agent $0.075/min [39]; Cartesia agents $0.06/min [33] | $0.60–0.80 + LLM |

Takeaway: a cascade with on-device STT is 2–10× cheaper than speech-to-speech per conversation. Its cost is dominated by TTS characters, which scale with how much we speak. That gives a second reason, beside UX, to keep spoken replies short and put long content on screen.

## 7. Integration notes for the router (implications, not research)

- **Provider interface.** Model TTS as a streaming sink: open a context, push text chunks, receive audio frames, cancel. ElevenLabs (WebSocket with `auto_mode` [32]) and Cartesia both fit. OpenAI no longer fits after 2027-01-06 [5].
- **Cancellation on barge-in** must abort three things together: local playback, the in-flight TTS context, and the LLM stream. Keep the spoken prefix so the transcript records only what the user actually heard. This mirrors how Gemini keeps only content already sent to the client [17].
- **Speech-to-speech adapters**, if added, should be a separate "voice engine" choice and not a router model. Their tool calls must be routed back into Psyche's approval flow before execution. OpenAI states explicitly that confirmations are the application's job [7]. Gemini's async calls can be cancelled by barge-in [17].
- **Pin snapshots.** Pin dated snapshots where vendors offer them (`sonic-3.6-2026-08-27` [34]) and track deprecations. Three OpenAI audio models in this doc have shutdown dates between 2027-01-06 and 2027-02-26 [5].
- **Session hygiene.** Close idle sockets. AssemblyAI bills connection time [41]; GPT-Live bills per second and costs about $0.05 per idle minute [4]; Gemini connections drop after about 10 min unless resumed [18].

## Sources

1. OpenAI, API pricing. https://developers.openai.com/api/docs/pricing
2. OpenAI, Realtime voice activity detection guide. https://developers.openai.com/api/docs/guides/realtime-vad
3. OpenAI, Realtime API guide. https://developers.openai.com/api/docs/guides/realtime
4. OpenAI, Voice latency and cost guide. https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime
5. OpenAI, Deprecations. https://developers.openai.com/api/docs/deprecations
6. OpenAI, GPT-Live guide. https://developers.openai.com/api/docs/guides/live
7. OpenAI, GPT-Live delegation and tools. https://developers.openai.com/api/docs/guides/live-delegation
8. OpenAI, GPT-Live conversations. https://developers.openai.com/api/docs/guides/live-conversations
9. OpenAI, "Introducing GPT-Live-1 in the API" (403 when fetched; date and voice details from search snippets and the model page). https://openai.com/index/introducing-gpt-live-1-in-the-api/ and https://developers.openai.com/api/docs/models/gpt-live-1
10. OpenAI, Voice prompting guide. https://developers.openai.com/api/docs/guides/voice-prompting
11. OpenAI, Text to speech guide. https://developers.openai.com/api/docs/guides/text-to-speech
12. The Next Web, coverage of GPT-Realtime-2 (2026-05-08). https://thenextweb.com/news/openai-gpt-realtime-2-voice-models
13. DataNorth, "OpenAI releases gpt-realtime-2.1 voice models" (secondary). https://datanorth.ai/news/openai-releases-gpt-realtime-2-1-voice-models
14. VentureBeat, "OpenAI launches GPT-Live" (2026-07-08). https://venturebeat.com/technology/openai-launches-gpt-live-a-full-duplex-voice-upgrade-that-lets-chatgpt-talk-more-like-a-person
15. Google, Gemini API pricing. https://ai.google.dev/gemini-api/docs/pricing
16. Google, Live API overview. https://ai.google.dev/gemini-api/docs/live
17. Google, Live API capabilities guide (VAD, interruptions, transcription). https://ai.google.dev/gemini-api/docs/live-guide
18. Google, Live API session management. https://ai.google.dev/gemini-api/docs/live-session
19. Google, Live API tool use. https://ai.google.dev/gemini-api/docs/live-tools
20. Google, Gemini 3.8 Live model page. https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live
21. TechNews (Taiwan), Gemini 3.8 Live launch coverage (2026-09-16). https://technews.tw/2026/09/16/google-releases-new-gemini-models-built-to-improve-conversing-capabilities-of-voice-agents/
22. Google Cloud, Live API best practices (per-turn billing). https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/best-practices
23. Anthropic, Models overview. https://platform.claude.com/docs/en/about-claude/models/overview
24. Anthropic Help Center, Use voice mode. https://support.claude.com/en/articles/11101966-use-voice-mode
25. The Decoder, "Anthropic's Claude uses ElevenLabs technology for speech features". https://the-decoder.com/anthropics-claude-uses-elevenlabs-technology-for-speech-features-rather-than-an-in-house-model/
26. Developers Digest, Hume EVI entry (reports 2026-11-13 shutdown; secondary). https://www.developersdigest.tech/voice-agents/hume-evi
27. Sesame, CSM-1B model card. https://huggingface.co/sesame/csm-1b
28. Sesame, "Crossing the uncanny valley of conversational voice" (2025-02-27). https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice
29. Kyutai, Moshi model card. https://huggingface.co/kyutai/moshiko-candle-q8
30. ElevenLabs, Models. https://elevenlabs.io/docs/overview/models
31. ElevenLabs, API pricing. https://elevenlabs.io/pricing/api
32. ElevenLabs, Latency optimization. https://elevenlabs.io/docs/developers/best-practices/latency-optimization
33. Cartesia, Pricing. https://cartesia.ai/pricing
34. Cartesia, TTS models (latest). https://docs.cartesia.ai/build-with-cartesia/tts-models/latest
35. Cartesia, Sonic product page. https://cartesia.ai/sonic
36. Vapi Humanness Index, Cartesia Sonic 3.5. https://humannessindex.vapi.ai/models/cartesia-sonic-3-5
37. Google Cloud, Text-to-Speech pricing. https://cloud.google.com/text-to-speech/pricing
38. InventiveHQ, TTS and STT API cost calculator (third-party, dated 2026-10-08). https://inventivehq.com/tools/developer/tts-stt-api-cost-calculator
39. Deepgram, Pricing. https://deepgram.com/pricing
40. Deepgram, Flux quickstart and configuration. https://developers.deepgram.com/docs/flux/quickstart and https://developers.deepgram.com/docs/flux/configuration
41. AssemblyAI, Pricing. https://www.assemblyai.com/pricing
42. Stivers et al., "Universals and cultural variation in turn-taking in conversation", PNAS 106(26), 2009. https://doi.org/10.1073/pnas.0903616106. Offset figures as quoted in Language Log: https://languagelog.ldc.upenn.edu/nll/?p=7997
43. Levinson and Torreira, "Timing in turn-taking and its implications for processing models of language", Frontiers in Psychology 6:731, 2015. https://www.frontiersin.org/articles/10.3389/fpsyg.2015.00731/full
44. OpenAI, "Hello GPT-4o" (2024-05-13; 403 when fetched, figures confirmed in the GPT-4o System Card). https://openai.com/index/hello-gpt-4o/ and https://arxiv.org/abs/2410.21276
45. Artificial Analysis, Speech to Speech leaderboard (time to first audio, index). https://artificialanalysis.ai/speech-to-speech
46. Artificial Analysis, Claude Haiku 5.5 (output speed; its TTFT figure is for max effort and not useful here). https://artificialanalysis.ai/models/claude-haiku-5-5
