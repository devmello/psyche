# @psyche/model-router

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
