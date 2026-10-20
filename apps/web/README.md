# @psyche/web

**Owner:** S11 (`prompts/s11-desktop-web-shell.md`). Features A8, E10 and the shell side of D5, I1, I6, K6, Q1 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md); screens from [docs/06-ui-design.md](../../docs/06-ui-design.md).

The Psyche React shell, served by the Gateway at `/` and hosted by the desktop renderer. One codebase, two hosts: the shell talks to a `ShellPlatform` port, and each host provides it. Both hosts render the same composed app (`src/compose/PsycheApp.tsx`: the shell with the UI kit's onboarding, chat column, agent sheet and Settings), so the web client is the desktop app minus native panes (feature A8).

## Run

```sh
pnpm --filter @psyche/web dev        # Vite on http://127.0.0.1:5173, proxies /healthz and /ws to 127.0.0.1:7979
pnpm --filter @psyche/web build      # → apps/web/dist; the Gateway serves it at /
pnpm --filter @psyche/web test       # vitest: client, shell store, layout engine, keyboard, voice, terminal pane,
                                     # and the production build served by a real Gateway (startGateway)
pnpm --filter @psyche/web typecheck
```

## Public API (package exports)

| Export | What |
| --- | --- |
| `@psyche/web/client` | `GatewayConnection` (handshake → RPC + events, idempotency keys for side-effecting methods, validated events, `seq`-gap resync, reconnect with backoff), `Handshake`, `connectSigningPayload`, status reducer, base64url. No DOM, no Node built-ins; the desktop main process uses it too |
| `@psyche/web/platform` | `ShellPlatform` and its ports: `GatewayPort`, `BrowserPort`, `TerminalPort`, `WindowPort`, `NotifyPort`, `KeyValueStore`, `ShellCommand` |
| `@psyche/web/shell` | `ShellApp`, `ShellStore`, the pane layout engine (`reduceLayout`, `presentation`, `applyViewCommand`, `toViewLayout`, `createLayoutStore`), the keyboard map |
| `@psyche/web/testing` | `MockGateway` (test only): verifies the Ed25519 challenge, answers RPCs from handlers, pushes events, and plays the Gateway end of the browser bridge |

## Shell layout

| Path | What |
| --- | --- |
| `src/shell/ShellApp.tsx` | Rail, thread list, chat, pane area; routes (docs/06 §2.7); keyboard handler; `view.command` → layout → `view.report`; quick entry and pop-out routes |
| `src/shell/store.ts` | Threads, messages, streaming deltas, pending approvals with this surface's answer tokens, notifications, toasts; refetch on resync |
| `src/shell/layout/` | Pure pane layout engine, persisted per thread |
| `src/shell/components/` | Chat (messages, approval dock, composer, quick entry), browser pane chrome, panes, palette, shortcut sheet, model picker, banners |
| `src/shell/panes/TerminalPane.tsx` | xterm tabs over `TerminalPort` |
| `src/shell/voice.ts` | Dictation capture: 16 kHz PCM to `voice.*` |
| `src/platform.ts`, `src/gateway.ts` | The web host: browser WebSocket to `location.origin`, `localStorage` |
| `src/main.tsx`, `src/compose/app.css` | The web entry: `PsycheApp` over the web platform, the kit stylesheet through `@tailwindcss/vite` |

## Web specifics (docs/06 §3.24)

- **Only `location.origin`** (security §10, CVE-2026-25253): `src/lib/ws-url.ts` takes the origin alone, so neither a query string nor a hash can supply a Gateway address or token (`test/ws-url.test.ts`).
- Browser connections are never auto-approved: a new browser shows the pairing banner with its code until a paired device approves it.
- Below 720 px the rail becomes a bottom tab bar (Chat, Feed, Ideas, Goals, Library), the thread list is hidden and panes open one at a time full screen.
- No native panes: the browser pane says it lives in the desktop app (the server sidecar screencast is S08's), the terminal is desktop-only, notifications stay in the in-app inbox.
- CSP meta: `default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'`. The dev server alone relaxes `script-src` for the React refresh preamble.

## Stubbed

- Device key: an in-memory WebCrypto Ed25519 pair (non-extractable); every reload is a new device. Persisting it in IndexedDB and passkey login are INT-2 (hooks: the pairing banner and `createWebGatewayConnection`).
- Feed, Ideas, Goals, Library and Search still show the shell's placeholders in the composed app (the kit has the screens; mounting them is next).
- Methods the protocol lacks are treated as unavailable: `commands.list`, `threads.update` (mode, model), `library.upload` (attachments), `voice.*`, `terminal.open`, `chat.queue.*` (S01's protocol branch).
- Web Push, the server-mode browser screencast, and a keyboard-operable pane resizer.
