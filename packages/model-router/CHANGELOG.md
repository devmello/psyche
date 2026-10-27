# @psyche/model-router

## Unreleased (pre-0.3.0)

### Minor Changes

- Subscription CLIs as model providers: `claude-code/<model>` (Claude Code headless, the owner's Claude plan) and `codex/<model>` (Codex `exec --json`, the owner's ChatGPT plan), with Psyche's tools bridged over a stdio MCP relay so the agent loop and Permission Broker still run every tool, session resume per turn, and a probe for installed / signed in that reports no account details. Listed by default in Settings → Model & providers as subscription providers.
- Voice conversation contract (V-G #691): `voice.conversation.*` methods and events, `via: "voice"` on approval answers and messages, `StartTurnInput.voice`, a `voice` model role (falls back to primary), a two-key `dictation.watch`, and the helper's speech shapes for V-H.

### Patch Changes

- Provider keys (#504): `models.setKey` normalizes a pasted key and refuses ones that cannot work (whitespace, Claude subscription tokens, Admin keys, wrong shape) with a reason; the probe reports the provider's own reason and tells a refused key from a malformed request; onboarding checks a key right after saving it; Settings → Model & providers can add or replace a key and checks it at once.
- Subscription CLIs are found under launchd (#530): `claude` and `codex` resolve from PSYCHE_CLAUDE_PATH / PSYCHE_CODEX_PATH, PATH, Homebrew and user install directories, and the login shell; the probe shows the resolved path; the LaunchAgent plist sets a PATH with Homebrew first.
- Subscription CLIs (#538): a history that ends with tool results keeps the tool exchange in the transcript, so the tool check's `uses_tool_result` case passes on `claude-code`; `models.list` reports a CLI provider as configured once its probe finds it installed and signed in.
- Context windows for the subscription CLIs (#558): Claude Code models report 200k (1M for `[1m]` variants) and Codex 272k, so `models.list`, Settings and the chat's context meter agree; when a window is unknown, Settings shows the 128k the chat assumes.
- Remove the text-to-speech surface from the protocol: `speech.readAloud*`, `speech.voices`, all `voice.conversation.*` methods and events, `speech.audio` and the read-aloud events, the helper's synthesis schemas and the `voice` model role. Dictation, voice memos and the two-key watch stay.

## 0.3.0-alpha.0

### Minor Changes

- dc0fc10: `llamacpp` and `lmstudio` provider kinds with local-server wire fixes, Google `googleApi: "generate-content"`, opt-in OpenRouter attribution, per-provider tool-name rules, and `probeEndpoint` (B4): reachability, model list and capability guesses with a `not_probed` state.
- e307aba: Model router: AI SDK v7 adapters (Anthropic, OpenAI Responses, Google Interactions, OpenRouter, OpenAI- and Anthropic-compatible, Ollama), roles with fallbacks, cooldowns and auth-profile rotation, strict per-thread models, vault-injected keys, usage ledger with LiteLLM prices and budget alerts, capability probe and embeddings.

### Patch Changes

- 7736e20: Anthropic thinking replay (#306): thinking envelopes carry a fingerprint of the system prompt and tools they are bound to; a completed turn's stale block is dropped on replay, no earlier thinking is sent when thinking is off, and requests that still replay thinking ask the API to `drop_block` on a prefix mismatch.
- 0d41013: Tool input schemas (#414): a top-level `anyOf` / `oneOf` / `allOf` of object variants is sent as one object (merged properties, common `required`, variants summarized in `description`); a tool whose schema still is not a top-level object fails the request locally with a `bad_request` naming the tool. `toolSchemaProblem` is exported for callers' own checks.
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
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
- Updated dependencies [13afc8a]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [0c71158]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
