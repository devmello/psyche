# @psyche/web

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
