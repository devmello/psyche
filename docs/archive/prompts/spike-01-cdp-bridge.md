# Spike 01 — Electron WebContentsView + CDP bridge to an external process

Time box: one day. You are a Psyche engineer (read `README.md`) running a throwaway prototype in `spikes/cdp-bridge/` with a write-up in `docs/spikes/spike-01-cdp-bridge.md`. Do not touch any package. Branch `spike/01-cdp-bridge`.

## Read first
`prompts/_shared-rules.md`; `docs/02-architecture.md` §5 and §8; `research_notes/Psyche personal agent landscape/agent_browser_and_credentials.md` KQ1.

## Question to answer
Can an Electron 44 app host agent-controlled tabs as `WebContentsView`s in a `persist:` partition, attach `webContents.debugger` per tab, and forward raw CDP commands/events over a Unix socket to a separate Node process fast enough for an agent loop, while a human can still use the same tab?

## Build
1. Minimal Electron app: `BaseWindow`, a sidebar, two `WebContentsView` tabs in `persist:agent-spike`.
2. A Unix-socket server in the main process that accepts `{tabId, method, params}` and returns results/events (`Accessibility.getFullAXTree`, `DOM.getDocument`, `Runtime.evaluate` in an isolated world, `Input.dispatchMouseEvent`, `Input.insertText`, `Page.navigate`, `Page.startScreencast`).
3. A separate Node client that: takes a full AX tree of a real page (for example a news site and a login form fixture), builds a pruned snapshot with stable refs and bounding boxes, clicks and types by ref, and records 10 screencast frames.
4. "Take control": while the user types in the view, the client's inputs are refused; on release they resume.
5. Measure: snapshot latency for 5 pages, round-trip per command, memory per tab; test `setWindowOpenHandler` with an OAuth-style popup and `will-download` with a PDF.

## Report
Numbers, gotchas (focus requirements for `sendInputEvent` vs CDP `Input.*`, isolated worlds, partition paths via `ses.storagePath`, debugger detaching when DevTools opens), a recommended bridge frame format, and a go/no-go for ADR-007 with any amendments. Keep the code runnable with one command.
