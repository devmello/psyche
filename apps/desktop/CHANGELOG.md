# @psyche/desktop

## Unreleased (pre-0.3.0)

### Minor Changes

- Localization groundwork (A12):
  - an ICU message catalogue with `t()`, `I18nProvider` and `describeError` for Gateway errors;
  - locale-aware formatting from the macOS region format, with Settings → Appearance → Language and region (`ui.locale`, `ui.direction`);
  - `pnpm i18n:check` against hard-coded UI text and missing ids, with a shrink-only baseline;
  - the chat's context UI extracted and right-to-left safe.
- Voice conversation key (V-G G4, #691): with voice conversation on, the helper's watch carries the voice key beside the dictation key (one watch, two roles), and the app renderers get `psyche.voice.onKey` and `psyche.voice.onSystem` (screen lock and sleep) to drive and end conversations.
- Voice HUD window (V-G, #691, spec §6.2): with voice conversation on, main keeps a warm, hidden, non-activating panel running the renderer at `/voice-hud` and shows it top-centre when the voice key goes down in any app. The preload bridge gains `psyche.voiceHud.{done, openThread}`; main accepts them only from the HUD window. `done` destroys the window (freeing the microphone) and warms a fresh one; `openThread` also brings up the main window on that thread. Screen lock and sleep destroy it until the Mac is back. The HUD may call the Gateway and use the microphone like an app renderer.
- Remove spoken output from the UI: the voice capsule, lantern, voice HUD window, the shell's voice mode, the Voice button and the voice, speed, narration, barge-in, approval and brief settings. Voice is speech-to-text: the voice key opens the ask panel in voice mode and the answer is text. Settings keeps "Talk with Psyche", the voice key and "Review before sending".
- The ask panel is the voice pop-up (part of #693): hold the voice key, speak, and let go. The words are sent as a plain chat (or left in the input when Review before sending is on) and the answer appears as text. The panel window now exists when Ask about screen or Talk with Psyche is on; screen capture still follows Ask about screen. A `VoiceKeySource` seam in desktop main keeps the macOS key watch replaceable.

### Patch Changes

- Web Bot Auth (I14): the browser signs document requests of profile tabs with the vault's Ed25519 key for sites that ask (`Accept-Signature`) or the owner lists; the vault creates and rotates the key (schema v2 allows `signing_key`); the Gateway serves the key directory and `browser.botAuth.status | rotate`; the desktop allows narrow document `Fetch` and merges signature headers into the real request.
- Bundled skills map their capability names to the Gateway's real tools and say why they are unavailable; gating follows the live tool set; the psyched build fails without its skills folder and the smoke lists the shipped skills (#506).
- Subscription CLIs are found under launchd (#530): `claude` and `codex` resolve from PSYCHE_CLAUDE_PATH / PSYCHE_CODEX_PATH, PATH, Homebrew and user install directories, and the login shell; the probe shows the resolved path; the LaunchAgent plist sets a PATH with Homebrew first.
- The Mac helper no longer synthesizes speech: `speech.synthesize`, `speech.prepare`, `speech.voices` and `speech.personal_voice.authorize` are gone, and `speech.status` no longer reports Personal Voice or `synthesisFirstAudioMs`. Speech-to-text is unchanged (part of #692).

## 0.3.0-alpha.0

### Minor Changes

- 2354dff: Desktop and web shells: one shared React shell with panes, palette and keyboard map; the embedded agent browser with its CDP bridge and Take control; terminal pane; menu-bar item, quick entry, deep links and Gateway supervision.
- 4ea143d: Auto-update verifies a signed update manifest (Ed25519 release key embedded in the app, pinned release host, no downgrades, per-artifact SHA-256) before Squirrel.Mac sees anything; the release workflow signs it.

### Patch Changes

- d8d5631: Pause-when-unwatched for the browser (#272): actions on sensitive-category origins need the pane visible and recent owner input, else `presence_required/awaiting_attention`; the desktop reports pane visibility and owner input to the Gateway.
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [81cf744]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [8e13e02]
- Updated dependencies [3bfb9f9]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [493b4a5]
- Updated dependencies [eaf91c6]
- Updated dependencies [19c1ba5]
- Updated dependencies [4f74993]
- Updated dependencies [5e605af]
- Updated dependencies [8a8dacb]
- Updated dependencies [6665567]
- Updated dependencies [310ac67]
- Updated dependencies [2f63bac]
- Updated dependencies [dc190a6]
- Updated dependencies [5d2cbeb]
- Updated dependencies [0899f3b]
- Updated dependencies [08664c3]
- Updated dependencies [e54d672]
- Updated dependencies [3461262]
- Updated dependencies [8a9ee2c]
- Updated dependencies [f80b0ec]
- Updated dependencies [75a0f80]
- Updated dependencies [2e9c025]
- Updated dependencies [e4c109b]
- Updated dependencies [5dcf208]
- Updated dependencies [c840e75]
- Updated dependencies [2607fc3]
- Updated dependencies [4bc7113]
- Updated dependencies [515b904]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [2b2e906]
- Updated dependencies [2354dff]
- Updated dependencies [e90b086]
- Updated dependencies [13afc8a]
- Updated dependencies [174516f]
- Updated dependencies [0b242ac]
- Updated dependencies [f5d6a65]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [534326e]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [0c71158]
- Updated dependencies [c1d8e4a]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
  - @psyche/ui@0.3.0-alpha.0
  - @psyche/web@0.3.0-alpha.0
  - @psyche/viewers@0.3.0-alpha.0
