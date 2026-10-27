# INT-2 plan: browser, Google connector, Telegram, server mode

Prompt: [prompts/int-2-browser-connectors-channels.md](../prompts/int-2-browser-connectors-channels.md). Branch `int/2-browser-connectors-channels`, on INT-1's composition root (`apps/gateway/src/compose/`). Status: [docs/status/int-2.md](../status/int-2.md).

## Goal

The three scenarios pass with the scripted model in CI and by hand with live services:

1. **Browser** from chat over the desktop bridge (new-origin approvals, cart, purchase card, Take control, pane closed, Activity and replay).
2. **Google**: connect, triage, send with an exact-binding approval and a receipt, calendar write with approval and receipt.
3. **Telegram + server mode**: Gateway in Docker Compose behind Tailscale Serve, the Mac as a remote node, owner pairing on Telegram, approvals answered on whichever surface is first.

## Steps

1. **Composition hooks** (`compose/index.ts`, `services.ts`, `call-context.ts`). `composeGateway({ parts })`: each part gets the composed services (db, broker, notifier, audit, a tool registry, `publish`) and returns handlers, tools and start / stop hooks.
   - `CallContexts` records the loop's `ToolRunContext` per call id. Package executors get the thread, run, task, taint, mode and the call's approval id: S08 `BrowserToolDeps.context` and S09 `approvalFor`.
   - A part's `relay` adds the owner's chat surfaces to every approval, delivers it to chat (S10 `deliverApproval`) and names owner senders for the broker.
2. **Browser part** (`compose/browser.ts`).
   - The Gateway listens on `$PSYCHE_HOME/run/browser-bridge.sock` with the per-launch handshake secret, and each desktop connection gets a `CdpBridgeDriver`.
   - `browser.*` agent tools hold a driver proxy, so a reconnecting desktop swaps the driver underneath them.
   - Each Task (or thread) gets one session, its origin policy and an opt-in recording.
   - Status pill and highlight go out through `bridge.tab.status`. The client `browser.*` methods are served here too.
3. **Connectors part** (`compose/connectors.ts`, subagent). `ConnectorRegistry` with Google, the injected `TokenVault` stand-in, a sync timer, and the protocol-known `connectors.*` handlers.
4. **Channels part** (`compose/channels.ts`, subagent). `ChannelService` on SQLite, Telegram and WebChat, inbound → chat turns, replies back out, `channels.*` with admin checks, approvals over chat.
5. **psyched** mounts the parts from its environment (`compose/parts.ts`).
6. **Tests** in `tests/integration/{browser,google,telegram,server-mode,injection}`: scripted model, `MockDesktop`, fake Google and fake Telegram Bot API. Live variants sit behind `PSYCHE_LIVE_TESTS=1`.
7. **Compose**: S22's file is not merged, so a temporary `tests/integration/server-mode/compose.yaml` stands in, with Tailscale Serve as a sidecar.
8. **Injection corpus** (S18 runner) against a stack of the real broker plus the real browser and connector tool descriptions. The report is attached to the PR.

## Interfaces used

- `@psyche/browser`: `BridgeServer`, `CdpBridgeDriver`, `registerBrowserTools`, `FileRecordingSink`, `FsQuarantineWriter`.
- `@psyche/connectors`: `ConnectorRegistry`, `googleFactory`, `connectorHandlers`.
- `@psyche/channels`: `ChannelService`, `SqliteChannelStore`, `TelegramAdapter`, `createChannelsApi`.
- The Gateway's `startGateway({ handlers })` hook (#45) and the broker contract.

## Risks

- Package gaps: anything a package lacks goes to its owner as an issue or small PR, never patched here.
- The fixture browser runs on `MockDesktop`, not Electron. The Electron path needs the desktop's real bridge client (S11) and stays a manual step.
- Server mode needs Docker and a tailnet. CI checks the Compose file statically only.
