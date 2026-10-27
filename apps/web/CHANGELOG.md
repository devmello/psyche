# @psyche/web

## Unreleased (pre-0.3.0)

### Minor Changes

- Context usage in the chat: the header meter bound to `threads.contextUsage` and `thread.context.updated`, "Compact now" (`threads.compact`), per-chat limits (`threads.setContextLimits`) from the thread menus, compaction markers on `compaction` blocks with the turns they replaced, and Settings bounds that match the Gateway's.
- Voice mode (Q5), off by default: a Voice button in the composer runs a spoken conversation (hands-free or hold to talk) with a listening / thinking / speaking state bar, replies in the persona's voice or the app's built-in voice, and interrupt-by-talking; approvals stay cards and are never answered by voice. Settings → Voice & dictation → Voice mode.
- Localization groundwork (A12):
  - an ICU message catalogue with `t()`, `I18nProvider` and `describeError` for Gateway errors;
  - locale-aware formatting from the macOS region format, with Settings → Appearance → Language and region (`ui.locale`, `ui.direction`);
  - `pnpm i18n:check` against hard-coded UI text and missing ids, with a shrink-only baseline;
  - the chat's context UI extracted and right-to-left safe.
- The composed app (web and desktop) fills the kit's `renderEditor` slot with the viewers' Markdown editor, so Soul & Memory edits persona files in Rich / Source / Diff. Lines the teaching loop wrote show their margin mark. `ControlledMarkdownEditor` is the controlled form: the host keeps the draft, budget, Save and Discard, and `MarkdownEditor` gains `chrome: "modes"` to show only the mode switch.
- Record meeting in the shell: the consent dialog ("I've told everyone"), a visible recording pill, microphone capture streamed to the Gateway as PCM chunks, a silence stop after five minutes, and `requestRecordMeeting()` plus a palette entry to start it.
- Remove spoken output from the UI: the voice capsule, lantern, voice HUD window, the shell's voice mode, the Voice button and the voice, speed, narration, barge-in, approval and brief settings. Voice is speech-to-text: the voice key opens the ask panel in voice mode and the answer is text. Settings keeps "Talk with Psyche", the voice key and "Review before sending".
- The output canvas in the app: artifact cards open one canvas pane beside the chat (its artifact swapped in place; recents are its tabs), code and images render through the viewers, and a new artifact from the owner's own live run opens the canvas automatically (others stay a card).
- The ask panel is the voice pop-up (part of #693): hold the voice key, speak, and let go. The words are sent as a plain chat (or left in the input when Review before sending is on) and the answer appears as text. The panel window now exists when Ask about screen or Talk with Psyche is on; screen capture still follows Ask about screen. A `VoiceKeySource` seam in desktop main keeps the macOS key watch replaceable.
- Chart, diagram and diff artifacts (chat experience phase 5): a chart renderer drawn by the client from a small spec (no model JS), diffs through the diff block, Mermaid diagrams drawn in strict mode as images, and gateway support (merge-patch for charts, text ops for diagrams and diffs).
- HTML artifacts in the canvas (chat experience phase 5): previewed in the opaque-origin artifact sandbox, off by default for content from untrusted sources until the owner presses Run, and creatable through `artifact.create`.

### Patch Changes

- Provider keys (#504): `models.setKey` normalizes a pasted key and refuses ones that cannot work (whitespace, Claude subscription tokens, Admin keys, wrong shape) with a reason; the probe reports the provider's own reason and tells a refused key from a malformed request; onboarding checks a key right after saving it; Settings → Model & providers can add or replace a key and checks it at once.

## 0.3.0-alpha.0

### Minor Changes

- 3bfb9f9: Settings → Model & providers over `models.*` (B1, B4): the Gateway lists configured providers with their last endpoint probe, probes and runs the tool-calling check only on the owner's click, and binds primary / utility picks (a chat-only primary asks before `override`); the Settings UI shows probe state, model capabilities (vision, tools, context) and the picks; the web model picker suggests the listed models.
- 2354dff: Desktop and web shells: one shared React shell with panes, palette and keyboard map; the embedded agent browser with its CDP bridge and Take control; terminal pane; menu-bar item, quick entry, deep links and Gateway supervision.
- e90b086: The web client's Settings → Devices & nodes lists, adds and removes this browser's passkeys, and approval cards that require authentication (purchases, credential fills, host commands, security settings) are approved with a passkey assertion over the card's presence challenge. The kit's `GatewayClient` gains an optional `presence` hook for that. Fixes the Gateway's WebAuthn challenge for `sha256:`-prefixed presence challenges, which made every real browser assertion fail.

### Patch Changes

- 8e13e02: Fresh presence for access-widening and destructive admin methods (devices.approve, channels access changes, memory.reset, backup.delete) and a device's first passkey; presence is sticky once enrolled (`presence_required` instead of an admin-only fallback); `psyched presence reset`. The web Passkeys panel retries a first passkey with the owner's approval.
- 534326e: Skills install and trust (T2): manifest validation and install policy (refused before any card), update detection, the Gateway's `skills.*` handlers and skill tools with third-party descriptions marked untrusted (part of #281), and Settings → Skills with the trust card.
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [81cf744]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
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
  - @psyche/viewers@0.3.0-alpha.0
