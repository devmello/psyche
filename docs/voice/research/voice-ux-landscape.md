# Voice UX landscape: how assistants handle turns, interruptions, state and actions

Research for the voice conversation mode spec. Researched 2026-10-25. Product behaviour changes often. Each claim carries its source and date, and "unverified" marks what I could not confirm from a primary source or a hands-on review.

## Answers for the spec

1. Put voice inside the chat, not on a separate screen. Show a live, scrollable transcript of both sides, and keep typing available mid-conversation. ChatGPT moved to this layout in November 2025 and kept the old screen only as an opt-in "Separate mode" [2]. Claude saves voice transcripts in chat history [24], and Gemini gives a transcript when a Live chat ends [12].
2. Ship hands-free as the default with push-to-talk as a setting. Claude offers both and recommends push-to-talk for noisy places [24]. ChatGPT users lost hold-to-talk in mid-2026 and are asking for it back [7].
3. Barge-in on by default. Stop playback within about 200 ms of the user speaking, and also offer tap or Esc to interrupt. Gemini lets users turn off voice interruption but keeps tap-to-interrupt [12].
4. Recommendation: wait about 1.0–1.5 s of silence after an incomplete-sounding phrase before replying. "Cuts me off when I pause" is the most common complaint for every product reviewed [4][7][27]. OpenAI's fix in GPT-Live was to stop relying on silence alone [1].
5. Before any consequential action (send, delete, pay, post), read back the specifics, ask a yes/no question, and wait for a clear yes. Read-only lookups proceed without asking. This follows Siri's default "repeat the message and ask for confirmation" [23], OpenAI's guidance [11] and Google's explicit-confirmation rule for hard-to-undo actions [33]. Psyche's existing approval card should appear on screen at the same moment.
6. Keep spoken replies to one or two short sentences and put the long content on screen. Speak a one-sentence preamble ("Checking your calendar.") only when a tool will take noticeable time [11].
7. Use four visual states: idle, listening, thinking and speaking. Drive the visual with input and output audio level, show live captions, and give a Reduce Motion fallback in which no state is conveyed by motion alone [34][35].
8. Require echo cancellation on the mic path, and treat speaker echo as the main source of false barge-in on a Mac. ChatGPT's Mac app interrupted itself through the built-in speakers in 2025 [8].

## 1. ChatGPT Voice (GPT-Live, formerly Advanced Voice Mode)

- **Engine.** Since 2026-07-08 ChatGPT Voice runs on GPT-Live: `GPT-Live-1` for paid tiers, `GPT-Live-1 mini` for free [1]. It is full duplex and decides "whether to speak, continue listening, pause, interrupt, or invoke a tool" many times per second [1]. It adds backchannels ("mhmm", "yeah", "got it") while the user talks and can be told to stay quiet and listen [1]. Hard requests go to GPT-5.5 in the background while the conversation continues [1]. During voice it shows visual cards for weather, stocks, sports and maps [1]. At launch it lacked voice plus video or screen share [1].
- **Turn-taking history.** In March 2025 OpenAI shipped an Advanced Voice update aimed at interrupting users less when they pause to think [4]. In July 2026 VentureBeat reported that GPT-Live "no longer relies on silence" to end turns, which had caused interruptions at brief pauses and with noise [1]. Users still report it interrupts before they finish a thought. One thread asks what happened to hold-to-talk, which they say appeared in mid-June 2026 and then disappeared [7]. On 2026-09-07 OpenAI support replied that users can ask Live to wait but pauses may still trigger a reply, with "No timeline to share" for hold-to-talk [7].
- **Voice inside chat (November 2025).** Voice used to open a separate screen with "an animated blue circle" showing listening or speaking, and replies were audio only [2]. Since 2025-11-25 voice runs in the main chat with live text of replies, plus images and maps inline. Users tap "End" to leave, and Settings > Voice Mode > "Separate mode" restores the old screen [2][3].
- **Mac app.** Voice was removed from the Mac app in January 2026, citing "incompatibility with its new voice architecture". It returned on 2026-07-23 with GPT-Live on macOS and Windows for paid plans [5]. It works across Chat, Work and Codex and can steer agents and Computer Use by voice [5]. "Appshots" lets voice reference the focused window, and screen and file access is opt-in [5][6]. OpenAI's demo asked "for confirmation where needed", but I found no documentation of how approvals work by voice (unverified) [6]. I found no official push-to-talk or keyboard shortcut for desktop voice (unverified).
- **What the API side says about UX.** OpenAI's GPT-Live docs say muting input does not stop the model talking, so stop playback locally [9]. Transcript deltas carry no turn boundaries, so the app must group them [9]. Spoken progress should match verified state ("still working, completed, or failed"), and success should be reported only after the backend confirms [10].

## 2. Gemini Live

- **Starting and stopping.** Open Live from the Gemini app or say "Hey Google, let's talk Live". "Hold" turns the mic off and pauses; "Mute" turns off the mic "but allow[s] Gemini to keep speaking". Ending a chat closes the session and produces a transcript [12].
- **Interruptions.** "While Gemini is talking, you can interrupt it by talking." Voice interruption can be turned off in Settings, but tapping the screen still interrupts [12]. The 2025 UI showed the hint "To interrupt Gemini, tap or start talking" [13].
- **Camera and screen sharing.** Both are built in. The camera switches front and back, and it turns off on Hold, on leaving the app or on screen lock, without auto-resuming. Screen sharing stops on Hold or lock and must be restarted [12]. These reached all Android users in April 2025 [13].
- **Captions.** A persistent captions setting applies to all Live chats [12]. Gemini can be used in the background with a call-style notification [12][13].
- **State display.** Today a pill-shaped voice indicator sits at the bottom of the screen. A teardown of Google app 17.65.17 (October 2026) shows a waveform replacing it and a speaker icon that silences spoken replies without changing system volume [14]. Today users who want silent replies have to turn on captions and lower the volume [14]. Gemini Live on the Mac app was in limited testing in June 2026, with Live controls at the bottom of a blank canvas [15].
- **Tools during Live.** Connected apps include Calendar, Keep, Tasks, YouTube, Spotify and Maps [12]. On the API side, Gemini 3.8 Live runs function calls asynchronously by default. Results can be announced immediately (`INTERRUPT`), after the current utterance (`WHEN_IDLE`) or silently (`SILENT`) [16]. Google says the Extended Thinking variant narrates progress while it reasons and calls tools in the background (secondary source) [17].

## 3. Siri on macOS 26 and 27

- **macOS 27 "Siri AI" (beta, English).** Announced 2026-06-08 and rolling out from 2026-09-14 [18]. On Mac it lives in Spotlight: Cmd-Space opens "Search or Ask", and answers appear there with follow-ups [21]. A standalone Siri app keeps conversations, which sync through iCloud [18][19]. Voice activation is hold the Microphone key, click the menu bar icon, or say "Hey Siri" or "Siri" if enabled [19][20]. Type to Siri is in Accessibility settings [19]. Users can "Swipe down on the Siri response to see the full menu" for longer answers and to ask follow-ups [19]. Requests run on device or on Private Cloud Compute [18]. Live-blog reports that the model is a licensed Gemini are not confirmed in Apple's materials (unverified).
- **Visual.** Since Apple Intelligence (macOS 15.1, iOS 18.1, October 2024), Apple's release notes describe "a glowing light that wraps around the edge of your screen" that responds to your voice [22]. TidBITS reported that on the Mac, Siri instead appears as a floating lozenge that shows voice input or accepts typing [22]. I found no description of the macOS 27 listening visual in Apple's pages (unverified).
- **Confirming actions.** By default Siri reads the message back and asks for confirmation before sending. iOS 16 and later have an "Automatically Send Messages" toggle to skip it, which is on by default for headphones and CarPlay [23]. Apple's 2026 materials do not describe confirmation prompts for the new in-app actions (unverified) [18][19].

## 4. Claude voice mode

- **Availability.** Beta on all plans: iOS, Android, Claude Desktop and web. It is "built to work best from your phone" [24]. It launched in English on mobile on 2025-05-27 with Sonnet 4 as the default and five voices [25]. In July 2026 voice gained Sonnet and Opus (previously Haiku-only "to reduce latency"), with Opus described as slightly slower [26]. Voice mode is not available in Claude Code or Cowork, which offer dictation instead [24].
- **Turn-taking.** Hands-free is the default: Claude "listens continuously and responds to natural pauses". It "works best when Claude can detect only one voice" [24]. Push-to-talk (hold a button) is the alternative for noisy places [24]. Users can interrupt at any time. If Claude interrupts by mistake, the user resumes talking and it stops [24].
- **Visual design.** The waveform icon starts voice (lower right on desktop and web, next to the mic on mobile). Stop sits in the same spot, and a settings button controls voice and pace [24]. At launch Claude displayed "key points on-screen as Claude speaks" and saved a transcript and summary [25].
- **Tools.** Connectors (Gmail, Calendar, Docs, Slack) "work the same way in voice mode as they do in text chat". Some results can't be displayed, and multiple tools may add a delay [24].
- **Reported failure.** On 2026-01-19 a user reported that voice mode cuts off speech mid-sentence, sometimes after a single phrase. This is single-sourced [27].

## 5. Sesame

- **"Voice presence" (research demo, 2025-02-27).** Sesame defines it through emotional intelligence, conversational dynamics ("timing, pauses, interruptions, and emphasis"), contextual awareness and consistent personality [28]. Its own write-up says the speech model does not model conversation structure: turn-taking, pauses and pacing. It calls fully duplex models the future [28].
- **Demo behaviour.** Reviewers describe deliberate hesitations and self-corrections that make the voices seem to be thinking [29]. One hands-on says it feels full duplex but is not: it processes speech after the user finishes [29]. I found no measured data on its backchannels or barge-in (unverified).
- **October 2026.** The iOS and Android app preview has a new voice model and agents that each have "access to its own computer". Users get an update when work is ready, can attach their own MCPs, and glasses are planned for 2027 [30].

## 6. Others, one line each

- **Alexa+.** Free with Prime or $19.99/month; pitched as conversational rather than transactional [31]. Internal documents reported responses of up to 10 s on older Echo devices against a 2–4 s target, and frequent failures with partner services [31].
- **xAI Grok Voice.** Fastest measured time to first audio among speech-to-speech models (0.70–0.81 s) [32]. I did not research its consumer UX.
- **Hume EVI.** Reported to shut down 2026-11-13, so not worth studying as a reference (see the cloud APIs doc).

## 6a. Side-by-side summary

| Product | Default input | Push-to-talk | Barge-in | Main visual | Transcript | Tools by voice |
|---|---|---|---|---|---|---|
| ChatGPT Voice (GPT-Live) | Hands-free, full duplex, backchannels [1] | Hold-to-talk reported removed mid-2026 [7] | Talk over it [5] | Live text in chat; old blue circle in Separate mode [2] | Live in chat [2] | Search, cards, Codex, Computer Use (desktop) [1][5] |
| Gemini Live | Hands-free [12] | Not documented (Hold/Mute instead) [12] | Talk or tap; voice barge-in can be disabled [12] | Bottom pill, waveform in testing [14] | Captions setting; transcript on end [12] | Google apps; camera and screen [12] |
| Siri AI (macOS 27) | Mic key, menu bar, "Siri"/"Hey Siri", or type [19][20] | Hold Microphone key [20] | Not documented | Spotlight panel; edge glow or lozenge since 15.1 [21][22] | Siri app history [19] | In-app actions; send confirmation by default [18][23] |
| Claude voice | Hands-free [24] | Yes, hold button [24] | Talk to interrupt [24] | Waveform button; key points on screen [24][25] | Saved in chat [24] | Connectors as in text [24] |
| Sesame | Hands-free [29] | Not documented | Talk to interrupt (reviewer) [29] | Not researched | Not researched | Agents with own computers, MCP [30] |

## 7. Patterns to borrow / avoid

### 7.1 Confirmation phrasing for actions

- **Borrow (Siri plus Google's rules).** For irreversible or external actions, read back the specifics and ask once. Google ranks explicit confirmation as rare and reserves it for actions "that would be difficult to undo" [33]. OpenAI says to name "the amount, target, and consequence" and not to call the tool "until the user clearly confirms" [11]. Example: "Text Sam: 'Running ten minutes late.' Send it?" Accept "yes", "send it" and "do it". Treat anything else, including silence, as no.
- **Borrow implicit confirmation for reads and low-risk writes.** Echo the parameter inside the answer ("Tomorrow at 9 you have the design review") [33]. After completing an action, say where it went ("Sent to Sam in Messages") [33].
- **Avoid a blanket "always ask"**, which OpenAI says causes friction [11]. Psyche's approval tiers should decide what needs a spoken yes. Never accept a spoken yes for anything the text UI would require a click for, unless the approval card is visible too.
- **Read back identifiers digit by digit**, and repeat the full corrected value after a correction [11].

### 7.2 Long answers

- Speak a summary of one or two short sentences, give one step at a time for procedures [11], and put the full answer in the transcript. Claude's on-screen key points [25], ChatGPT's in-chat text and cards [1][2], and Siri's swipe-down for the full response [19] all follow this split. Offer "Want me to read the whole thing?" rather than reading markdown, code or tables aloud.

### 7.3 Narrating tool steps

- Say one short preamble only when a tool will take noticeable time. Describe the action, not internal reasoning, and avoid "Let me think…" or "I am now going to access the tool…" [11]. Vary the wording [11].
- When background work finishes mid-conversation, choose how to surface it: interrupt, wait until idle, or stay silent. Gemini's `INTERRUPT`/`WHEN_IDLE`/`SILENT` scheduling is the model to copy [16]. Default to `WHEN_IDLE`.
- Never say "done" until the tool result confirms success. If cancellation was requested, confirm it actually stopped before saying so [10].

### 7.4 Earcons

- I found no 2026 documentation of earcon use in these products (unverified). Recommendation: a short, quiet start-listening tone and an end-of-session tone, each optional in settings. Do not chime on every turn. The visual state and the reply itself already signal turn changes.

### 7.5 Visual reacting to audio

- Every product ties its main visual to audio. ChatGPT's blue circle showed listening versus speaking [2]. Siri's edge glow "responds to your voice" [22]. Gemini is moving from a pill to a waveform [14]. Drive amplitude from mic RMS while listening and from playback RMS while speaking, and use a distinct non-audio animation for thinking. Thinking is the state users misread as "it didn't hear me".

### 7.6 Accessibility

- Offer live captions for both speakers and keep them on as a persistent setting, as Gemini does [12]. WCAG 2.2 SC 1.2.4 covers live captions for synchronized media; it does not strictly apply here but is the right bar [35].
- With Reduce Motion on, replace pulsing and scaling with opacity changes or a static icon plus a text label ("Listening", "Thinking", "Speaking"). Apple's guidance is not to rely on motion alone (paraphrased; the HIG page did not render for me) [34]. WCAG 2.2 SC 2.3.3 asks that animation triggered by interaction can be disabled [35].
- Keep keyboard paths for everything: start, stop, interrupt, mute mic, mute speech, and switch to push-to-talk. The Siri Microphone key and Gemini's tap-to-interrupt show the precedent [12][19].
- Offer a "silence replies" option (captions only), the gap Gemini is now filling [14].

### 7.7 Failure modes reported

| Failure | Evidence | Mitigation for Psyche |
|---|---|---|
| False barge-in from speaker echo | ChatGPT Mac app "seemingly listening to its own voice" through built-in speakers; fixed by headphones or lower volume (2025) [8]. Industry write-ups give the same diagnosis [36] | Use macOS voice processing (AEC) on a shared capture and playback path. Expect the canceller to need a short convergence period, the first few hundred milliseconds of playback, which an Apple engineer described on the forums [37]. Raise the barge-in threshold while speaking; require ~250 ms of sustained speech |
| Backchannels treated as interruptions | User "mm-hm" can stop the agent unless classified as a backchannel [36]; full-duplex models may mistake one for a turn [1] | Ignore short low-content utterances ("mm", "yeah", "ok") during playback, or duck volume instead of stopping |
| Cutting users off at pauses | ChatGPT 2025 and 2026 [4][7]; Claude 2026 [27] | Semantic end-of-turn plus a longer silence fallback after incomplete phrases; push-to-talk setting; "take your time" command |
| Latency and dead air | Alexa+ up to 10 s on old hardware [31]; older cascades ~1.7 s [1] | Budget in the cloud APIs doc; spoken preamble for slow tools; thinking visual within 300 ms |
| Mute that doesn't stop speech | GPT-Live: muting input does not stop output [9] | Separate "mute mic" and "stop speaking" controls, both local and instant |
| Spoken success before it happened | OpenAI warns against it [10] | Speak outcomes only from verified tool results |
| Background noise or other voices | Claude works best with one voice [24]; OpenAI says to respond only to clear audio and stay quiet for speech not directed at it [11] | Clarify once, never twice in a row [11]; drop low-confidence transcripts rather than act on them |

## Sources

1. VentureBeat, "OpenAI launches GPT-Live, a full-duplex voice upgrade" (2026-07-08). https://venturebeat.com/technology/openai-launches-gpt-live-a-full-duplex-voice-upgrade-that-lets-chatgpt-talk-more-like-a-person
2. Digit, "ChatGPT Voice now works right inside chats with live transcripts" (2025-11-26). https://www.digit.in/news/general/chatgpt-voice-now-works-right-inside-chats-with-live-transcripts-check-details.html
3. Gulf News, "OpenAI integrates ChatGPT Voice into main chat interface" (2025-11). https://gulfnews.com/technology/openai-integrates-chatgpt-voice-into-main-chat-interface-1.500360920
4. TechCrunch, "OpenAI says its AI voice assistant is now better to chat with" (2025-03-24). https://techcrunch.com/2025/03/24/openai-says-its-ai-voice-assistant-is-now-better-to-chat-with
5. iThinkDiff, "ChatGPT Voice returns to Mac with GPT-Live" (July 2026). https://www.ithinkdiff.com/chatgpt-voice-returns-mac-gpt-live-july-2026/
6. Pasquale Pillitteri, "ChatGPT Voice arrives on the desktop app" (secondary). https://pasqualepillitteri.it/en/news/8825/chatgpt-voice-desktop-control-ai-agents
7. OpenAI Community, "ChatGPT live voice still interrupts too much. What happened to hold-to-talk?" (2026-07-09; support reply 2026-09-07). https://community.openai.com/t/chatgpt-live-voice-still-interupts-too-much-what-happened-to-hold-to-talk/1386172
8. OpenAI Community, "Voice Mode not working in Mac App - Cutting Off" (2025-04-29 to 2025-05-16). https://community.openai.com/t/voice-mode-not-working-in-mac-app-cutting-off/1245791
9. OpenAI, GPT-Live conversations guide. https://developers.openai.com/api/docs/guides/live-conversations
10. OpenAI, GPT-Live delegation and tools guide. https://developers.openai.com/api/docs/guides/live-delegation
11. OpenAI, Voice prompting guide. https://developers.openai.com/api/docs/guides/voice-prompting
12. Google, Gemini Apps Help, Talk with Gemini Live. https://support.google.com/gemini/answer/15274899
13. 9to5Google, "Gemini Live camera and screen sharing" (2025-04-07). https://9to5google.com/2025/04/07/gemini-live-camera-screen-sharing/
14. Android Headlines, "Google tests Gemini Live interface with mute button" (2026-10-12). https://www.androidheadlines.com/2026/10/google-tests-gemini-live-interface-mute-button.html
15. Android Authority, Gemini Mac app tests Gemini Live (June 2026). https://www.androidauthority.com/gemini-mac-app-magic-pointer-gemini-live-voice-dictation-3681280/
16. Google, Live API tool use and Gemini 3.8 Live model page. https://ai.google.dev/gemini-api/docs/live-tools and https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live
17. TechNews (Taiwan), Gemini 3.8 Live launch coverage (2026-09-16). https://technews.tw/2026/09/16/google-releases-new-gemini-models-built-to-improve-conversing-capabilities-of-voice-agents/
18. Apple Newsroom, "Apple introduces Siri AI" (2026-06-08) and "Major updates for Apple's software platforms are now available" (2026-09-14). https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant/ and https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available/
19. Apple Support, Get started with Siri AI on Mac. https://support.apple.com/guide/mac-help/get-started-with-siri-ai-mac88e1mkh19/mac
20. Apple Support, Turn on and activate Siri on Mac. https://support.apple.com/guide/mac-help/turn-on-and-activate-siri-mchlb66b4ad6/mac
21. MacRumors, "macOS 27 Golden Gate hands-on" (2026-06-12). https://macrumors.com/2026/06/12/macos-golden-gate-hands-on
22. TidBITS, "Apple Intelligence arrives in macOS 15.1 Sequoia, iOS 18.1, and iPadOS 18.1" (2024-10-28), quoting Apple's release notes. https://tidbits.com/2024/10/28/apple-intelligence-arrives-in-macos-15-1-sequoia-ios-18-1-and-ipados-18-1/
23. iPhone Life, "How to send Siri text messages without confirming each one". https://iphonelife.com/content/how-to-send-siri-text-messages-without-confirming-each-one
24. Anthropic Help Center, Use voice mode. https://support.claude.com/en/articles/11101966-use-voice-mode
25. TechCrunch, "Anthropic launches a voice mode for Claude" (2025-05-27). https://techcrunch.com/2025/05/27/anthropic-launches-a-voice-mode-for-claude
26. iTechify, Claude voice mode adds Opus and Sonnet (2026-07-25; secondary). https://itechify.com/2026/07/25/claude-voice-mode-opus-sonnet/
27. Let's Data Science, "Claude voice mode cuts off sentences" (2026-01-19; single-source). https://letsdatascience.com/news/claude-voice-mode-cuts-off-sentences-4cdeef16
28. Sesame, "Crossing the uncanny valley of conversational voice" (2025-02-27). https://www.sesame.com/research/crossing_the_uncanny_valley_of_voice
29. Beebom, "I tried Sesame AI's voice companion". https://beebom.com/sesame-ai-voice-companion-maya-experience-like-talking-to-real-person/
30. TestingCatalog, "Sesame updates voice agents with their own computers" (2026-10-07). https://www.testingcatalog.com/sesame-updates-voice-agents-with-their-own-computers
31. TweakTown, "Amazon's new Alexa+ announced" (2025-02); The Decoder, "Older Echo devices, latency and AI bugs are slowing down Amazon's AI ambitions for Alexa". https://www.tweaktown.com/news/103565/amazons-new-alexa-announced-costs-19-99-free-for-amazon-prime-members/index.html and https://the-decoder.com/older-echo-devices-latency-and-ai-bugs-are-slowing-down-amazons-ai-ambitions-for-alexa/
32. Artificial Analysis, Speech to Speech leaderboard. https://artificialanalysis.ai/speech-to-speech
33. Google, Conversation design: Confirmations. https://developers.google.com/assistant/conversation-design/confirmations
34. Apple, Human Interface Guidelines: Motion (content paraphrased; page did not render in my fetch). https://developer.apple.com/design/human-interface-guidelines/motion
35. W3C, WCAG 2.2 Understanding SC 1.2.4 Captions (Live) and SC 2.3.3 Animation from Interactions. https://www.w3.org/WAI/WCAG22/Understanding/captions-live.html and https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
36. Soniox, "Turn-taking and barge-in" (vendor wiki). https://soniox.com/wiki/turn-taking-barge-in
37. Apple Developer Forums, "Acoustic Echo Cancellation does not work initially" (Apple engineer reply on convergence). https://developer.apple.com/forums/thread/829784
