# @psyche/browser

## Unreleased (pre-0.3.0)

### Minor Changes

- Web Bot Auth (I14): the browser signs document requests of profile tabs with the vault's Ed25519 key for sites that ask (`Accept-Signature`) or the owner lists; the vault creates and rotates the key (schema v2 allows `signing_key`); the Gateway serves the key directory and `browser.botAuth.status | rotate`; the desktop allows narrow document `Fetch` and merges signature headers into the real request.

### Patch Changes

- Run trace T1, Gateway sink (#660): `run_steps` and `run_frames`, one sink for chat and helper runs, `runs.*` with `psyche-trace+json` v1 and Markdown export, retention of thinking text (`data.reasoningRetentionDays`) and frames (`data.replayRetentionDays`), and redaction at write. `@psyche/browser` exports `redactUrl`.

## 0.3.0-alpha.0

### Minor Changes

- e0c2cf6: Agent browser: CDP driver over the desktop bridge and a Playwright driver on one shared page engine, accessibility snapshots with stable refs, per-task origin policy on every navigation hop, Take control, download quarantine, vault fills, opt-in recording and the `browser.*` tools.

### Patch Changes

- d8d5631: Pause-when-unwatched for the browser (#272): actions on sensitive-category origins need the pane visible and recent owner input, else `presence_required/awaiting_attention`; the desktop reports pane visibility and owner input to the Gateway.
- e4d6f48: `vitest` is a devDependency of `@psyche/browser` instead of an optional peer, so it (and vite, lightningcss) no longer lands in the Gateway's production install (#299 DEP-12).
- 7b10927: Vault fills are judged on the live element (type and focus re-checked right before typing) and screenshot suppression survives navigating back to a filled form (#291).
- 1cf5421: Real-Chrome mode (I13): the owner's Google Chrome on a Psyche-owned profile with a loopback DevTools port registered as Psyche's own, attached per task after a device-only, presence-checked consent, behind a routing driver so the browser tools, origin sets and vault rules stay the same.
- c3710ee: Browser: purchase cards list merchant, seller, items and total and bind to them, with the click refused when the order changed after approval; `browser.request_control` hands a tab to the owner (notification plus pane status) and waits for it back.
- 3a3fa6a: Dev preview (I12): `browser.dev_preview` opens the owner's own local dev server in a logged-out, port-pinned dev-preview session after a `new_origin` approval, gated by `DevServerRegistry` (servers Psyche started, the launch config, the owner's allowlist); `browser.console` and `browser.network` read that tab.
- 5760f08: Browser follow-ups: OS probes for the broker's localhost rule (dev preview now works for servers Psyche spawned and stays refused for anything else), and page-echo detection that withholds any tool output holding a vault value (S23 design-18); the Gateway wires the vault's redaction into the driver.
- 7de91d6: Browser: logged-out partitions by default (I15). Sessions choose `profile`, `clean` or `auto`; in `auto` a tab uses the owner's profile only for origins they signed into. Tabs report their partition, the pane gets it on `bridge.tab.open`, and the fixtures prove the isolation on both drivers.
- 1b7b61b: Browser recording and replay (I10): recordings hold an event log (tabs, navigations, snapshots, actions, fills, downloads, blocks, control, dialogs) beside the screencast frames, redacted at write time; `RecordingStore` and the Gateway's `browser.recordings.*` methods serve them to the Activity sheet, with 7-day retention and Library import.
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
