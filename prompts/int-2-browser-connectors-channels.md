# Integration 2 — Browser, Google connector, Telegram, server mode

You are building Psyche (read `README.md`). You are **INT-2**. Start after INT-1 is green and `packages/browser`, `packages/mcp-host`, `packages/connectors`, `packages/channels`, `packages/vault`, `packages/scheduler` and `apps/mac-helper` have merged. Work in your own worktree on branch `int/2-browser-connectors-channels`. Same editing rules as INT-1 (composition code and `tests/integration/**` only; small PRs to owners otherwise).

## Read first
`prompts/_shared-rules.md`; `docs/02-architecture.md` §3.2 (topologies A and C), §4.9, §4.10, §8; `docs/05-security-and-permissions.md` §6, §9, §10; `docs/03-feature-spec.md` rows I1–I9, M5, M8, N2, N4, N12, N13, G5–G8, O1, O4, O10; `docs/06-ui-design.md` (browser pane, connectors and channels settings); all `docs/status/*.md`.

## Goal
Three scenarios pass:
1. **Browser**: from chat, "find the cheapest 13-inch laptop stand on these two sites and hold the best one in a cart" → the embedded browser pane opens with the status pill and highlights → a new-origin approval → the agent fills the search, compares, adds to cart → stops before checkout with a confirm card listing seller, items and total (payment hand-off is M3) → the user takes control, types their own login, returns control → closing the pane keeps the task running → Activity shows every action with a replayable recording.
2. **Google**: connect Gmail and Calendar (desktop OAuth, production consent screen) → "triage my inbox and draft replies to anything from Alice" → thread previews inline → a send approval card with exact recipient and body hash → send → receipt with the Gmail message id → "put the dentist appointment from that email on my calendar" → calendar write approval → event created → receipt.
3. **Telegram + server mode**: run the Gateway in Docker Compose on a Linux box (or a local container) behind Tailscale Serve; pair the Mac app as a remote node; the owner pairs on Telegram with a code; sends "what's on my calendar tomorrow" from the phone and gets the answer; a purchase-sized approval requested from the server shows on the Mac with Touch ID-required notification and as Telegram buttons; the first authorized answer wins and the other surface dismisses.

## Work
Composition for the browser bridge (desktop) ↔ CDP driver (gateway); connector and channel mounting; trusted-proxy/passkey auth for the web client; Compose file from C2 (or a temporary one if C2 has not landed); the three integration tests (scripted provider for CI; live behind the env gate); timing measurements for snapshots and approval round trips.

## Definition of done
Scenarios 1–3 pass manually and the CI-safe parts pass automatically; `docs/status/int-2.md` lists gaps; the injection corpus runner (S18) is executed against the real browser and connector packages and the report is attached to the PR.
