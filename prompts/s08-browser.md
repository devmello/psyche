# Session S08 — Browser subsystem

You are building Psyche (read `README.md`). You are session **S08 — Browser**: `packages/browser`, the agent-owned browser the user can watch and take over. Work in your own worktree on branch `ws/s08-browser`. You own `packages/browser/**`. The pane UI and the Electron `WebContentsView` host belong to S11; you own the driver, the tools, the snapshot builder, the origin policy and the bridge protocol they share.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §5 (embedded browser pane), §8 (browser subsystem)
3. `docs/05-security-and-permissions.md` §6 (browser security) and §7 (injection defenses)
4. `docs/03-feature-spec.md` rows I2–I4, I7–I10, I12–I15
5. `docs/07-tech-decisions.md` ADR-007
6. Contracts: `BrowserDriver`, `PermissionBroker`, `CredentialBroker` (fill helper); bridge schemas in `packages/protocol`; fakes
7. Research: `agent_browser_and_credentials.md` KQ1 (Electron `webContents.debugger`, partitions, `setWindowOpenHandler`, `will-download`, Playwright `connectOverCDP`/aria snapshots with `boxes`, extension limits), KQ2 (product behaviors: take control, site grants), KQ3 (page representation: browser-use, Stagehand, Playwright `ariaSnapshotJSON`/`getByRef`); `docs/spikes/spike-01-cdp-bridge.md` if present

## Mission (M1)
- **`BrowserDriver` interface** (finalize in protocol via additive PR if needed): tabs (list/open/focus/close), navigate/back/forward/reload, `snapshot()` → accessibility tree with stable `ref_N` ids, roles, names, values, states, bounding boxes; `find(query)`; `readText()`; `screenshot()` (only when needed); actions by ref or coordinate (click, double/right click, hover, type, press, select, scroll, scrollTo, drag, upload, download); `waitFor` (load, selector, text, network idle, timeout); console and network read for localhost dev preview; events (navigation, dialog, download, take-control state).
- **CDP driver**: speaks raw CDP over the desktop bridge (Unix socket; frames defined in protocol): `Accessibility.getFullAXTree`, `DOM`/`Runtime` for refs, `Input.dispatch*`, `Page.navigate`, `Page.startScreencast` (recording), `Network.*`; attach per tab; the desktop owns the `WebContentsView`s and forwards CDP. Build a mock bridge for tests.
- **Playwright driver**: `launchPersistentContext(userDataDir)` for server/headless mode and `connectOverCDP` for real-Chrome mode; aria snapshots with `boxes`; same tool semantics; profile directories under `$PSYCHE_HOME/browser/profiles/<name>/`.
- **Snapshot builder**: pruned, depth-limited tree; interactive elements first; size cap with "more" paging; stable ref map per snapshot; sparse-tree detection → suggest screenshot.
- **Origin policy**: per-task origin sets (read-only vs read-writable), canonical host comparison, redirect checks, `about:`/`chrome:`/`file:` blocked, private-network and localhost rules (localhost allowed only for dev preview tasks), per-origin grants via `PermissionBroker` (`new_origin` approvals in tainted turns), reputation hook (local blocklist; optional remote check behind a flag).
- **Take control**: a `controlState` (`agent | user | paused`) toggled by the desktop; all agent actions are refused while `user`; resume on release; events for the status pill.
- **Downloads**: quarantined to the Library through a `LibraryWriter` interface with type sniffing; never auto-opened; receipt per download.
- **Credential fills**: call the vault's browser fill helper; never read field values back into model-visible text; mark `secureField` focus so screenshots are suppressed.
- **Tools for the agent**: register `browser.*` tool executors with the agent-core registration API (side-effect classes: navigation to known origins = read; form submit/upload = write; purchase paths = financial); provenance `untrusted` on all page content.
- **Recording**: screencast frames per task (opt-in) written to the Library; replay index for Activity.

## Out of scope
The pane UI and `WebContentsView` lifecycle (S11), Web Bot Auth (I14, later), computer use (S14).

## Definition of done
- Driver conformance suite (shared by both drivers) against a local fixture site: forms, popups/OAuth window routing, redirects, downloads, iframes, dialogs, take-control refusal, origin policy, sparse-tree fallback, 20-page regression set; CDP driver tests against the mock bridge; Playwright driver tests against bundled Chromium locally (skipped in CI if browsers are missing, with a documented `PSYCHE_BROWSER_TESTS=1` gate).
- Snapshot size and latency budget tests (<300 ms typical page).
- README: tool reference, bridge protocol, origin policy; `docs/status/s08.md`.

## Suggested subagents
One to build the fixture site and conformance suite, one to prototype the CDP tree→snapshot mapping, one to review origin-policy edge cases (redirects, IDN hosts, ports).

## M2 follow-ons
I10 replay UI data; I12 dev-preview console/network tools and element picker protocol; I13 real-Chrome launcher with Unix-socket debugging; I14 Web Bot Auth signer.
