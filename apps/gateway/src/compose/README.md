# Gateway composition root (INT-1, INT-2)

`composeGateway(options)` builds the real services and starts `psyched` with them; `main.ts` calls it. Owned by the integration sessions (INT-1..3), not S01.

| File | What it wires |
| --- | --- |
| `index.ts` | agent loop, model router or injected provider, Permission Broker + SQLite store, audit log, memory (with flush), task engine + worker pool, scheduler, notifier; mounts package handlers; forwards package events to the bus; applies `permissions.policy` changes |
| `handlers.ts` | adapters from package handler maps to `HandlerDef`; `questions.*` over the loop and the task engine |
| `approval-tokens.ts` | in-memory delivery of single-use answer tokens to the caller's surface (security §3.7) |
| `file-tools.ts` | stand-in `read_file` / `write_file` / `list_dir` until P9 ships (#49) |
| `models.ts` | `PSYCHE_MODEL` → router config with env keys (dev and live tests); `NO_MODEL` |
| `services.ts` | `ComposeServices` handed to each part; `ComposedPart`; `ApprovalRelay` (approvals over chat) |
| `call-context.ts` | the loop's per-call decision context (thread, run, task, taint, approval id) for package executors |
| `browser.ts` | bridge socket, `CdpBridgeDriver` per desktop, `browser.*` tools with per-task sessions and recordings, status pill, client `browser.*` methods |
| `connectors.ts` | `ConnectorRegistry` with Google, token vault stand-in, sync timer, `connectors.list` / `get` |
| `channels.ts` | `ChannelService` with Telegram and WebChat, inbound → chat turns, replies, `channels.*`, approvals over chat |
| `parts.ts` | the parts `psyched` mounts from its environment |

Approvals that need Touch ID or a passkey are refused until a `presence` verifier is passed (fail closed).

Status, gaps and timings: [docs/status/int-1.md](../../../../docs/status/int-1.md), [docs/status/int-2.md](../../../../docs/status/int-2.md).
