# Session S11 — Desktop and web shells

You are building Psyche (read `README.md`). You are session **S11 — Desktop and web shells**: `apps/desktop` (Electron 44) and `apps/web` (the same React app served by the Gateway). You host the UI components from `packages/ui` (S12) and viewers from `packages/viewers` (S13); you own windows, panes, the embedded browser host, the terminal pane, dictation capture, notification relay and the Gateway connection. Work in your own worktree on branch `ws/s11-desktop-web-shell`. You own `apps/desktop/**` and `apps/web/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §3.1, §5 (desktop shell), §8 (browser: what the desktop owns vs `packages/browser`)
3. `docs/06-ui-design.md` (all; the screen map, panes, keyboard map, browser pane, terminal, settings shell)
4. `docs/05-security-and-permissions.md` §6 (browser security), §10 (control plane), §12 (macOS specifics)
5. `docs/03-feature-spec.md` rows A6, A7, A8, E10, I1, I5, I6, I11, K6, D5, O10 (desktop relay), Q1 (composer UI)
6. `docs/07-tech-decisions.md` ADR-001, ADR-013
7. Protocol: WS client types, `view.*` methods, browser bridge schemas; `packages/ui` and `packages/viewers` placeholders; fakes (a mock Gateway server in `packages/testing`)
8. Research: `claude_desktop_and_peers.md` Q1 (panes, keyboard map, session rail), Q2 (browser pane behaviors), Q7 (Electron Forge + Vite stack, fuses, IPC naming); `agent_browser_and_credentials.md` KQ1 (`WebContentsView`, partitions, `webContents.debugger`, `setWindowOpenHandler`, `will-download`); `docs/spikes/spike-01-cdp-bridge.md` if present

## Mission (M1)
- **Shell**: Electron 44 (verify current stable), Electron Forge + Vite + React 19; single `BaseWindow` with the app in a `WebContentsView`; preload with a minimal typed bridge (no Node in renderer); fuses per architecture §5; Developer ID signing and notarization config (document the env vars; CI builds unsigned by default); auto-update feed placeholder; menu bar item (status, usage meter placeholder, Quit entirely vs Close window); quick-entry floating window with a global hotkey; deep link `psyche://`.
- **Gateway lifecycle** (A7): dev mode spawns `psyched` as a child; production installs/uses a LaunchAgent plist (coordinate the plist file with C2 in `deploy/`; you call it) so work continues when the window closes; reconnect with backoff; offline state UI.
- **Layout and panes**: left rail (Chat, Search, Feed, Ideas, Goals, Library) + thread list + chat center + pane area (browser, terminal, files, editor, diff, plan, tasks/activity, subagents, artifact, VM display placeholder); drag to split/resize, pop out to windows, `⌘\` close; pane state persisted per thread; `view.*` RPC so the agent can open/close/focus panes.
- **Embedded browser host**: one `WebContentsView` per tab in `persist:agent-<profile>`; tab strip, address display, back/forward/zoom/find; status pill and action-highlight overlay driven by `packages/browser` events; Take control (user input pauses the agent; release resumes), Open in window, full screen, Stop the task, "closing keeps the task running"; site-permission prompt (Allow once / Always allow / Deny) rendered from `ApprovalRequest`s of kind `new_origin`; credential-fill prompt; download quarantine toast; the **CDP bridge server** (Unix socket) that attaches `webContents.debugger` per tab and forwards commands/events to the Gateway per the protocol schemas; `setWindowOpenHandler` routing popups to new agent tabs; `will-download` handler; `EnableCookieEncryption` fuse; a "Clear browsing data" action.
- **Terminal pane**: node-pty + xterm (verify versions), tabs, "Open in terminal" from the files pane, sandbox or host shell chosen by the Gateway's response (agent PTY use requires approval; you only render).
- **Composer**: text with slash-command autocompletion data from the Gateway, attachments (drag/drop, paste, folders), permission-mode switcher (`⌘⇧M`), model picker (`⌘⇧I`), dictation button (push-to-talk and toggle) capturing audio and streaming to the Gateway's `voice.*` methods (engine is elsewhere), follow-up queue display.
- **Notifications relay**: OS notifications through the mac helper when present (actions, interruption level) else Electron `Notification`; click/actions routed back to the Gateway.
- **Keyboard map** from `docs/06`; command palette (`⌘K`) shell (search results from `packages/ui`).
- **Web shell** (`apps/web`): same React app without Electron-only features; works at phone width; passkey login UI hooks (INT-2 wires auth).

## Out of scope
Component visuals (S12), viewer internals (S13), browser tools/snapshots (S08), speech engines (S14/S17), Gateway logic.

## Definition of done
- Playwright-for-Electron smoke tests (launch, connect to the mock Gateway, open panes, keyboard shortcuts, browser pane tab lifecycle, take-control toggling, download toast); bridge protocol tests with a fake Gateway; unsigned CI build on macOS; web build served by the Gateway in a test.
- README: window/pane architecture, bridge, signing/notarization steps, LaunchAgent handoff; `docs/status/s11.md`.

## Suggested subagents
One for Electron Forge/Vite/fuses/signing setup, one for the browser host + CDP bridge, one for the pane layout engine, one for the terminal pane.

## M2 follow-ons
VM display pane (helper framebuffer), system-wide dictation hotkey UI, split view by `⌘`-click, session rail/context card, Windows/Linux packaging.
