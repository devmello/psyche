# Gateway composition root (INT-1, INT-2)

`composeGateway(options)` builds the real services and starts `psyched` with them; `main.ts` calls it. Owned by the integration sessions (INT-1..3), not S01.

| File | What it wires |
| --- | --- |
| `index.ts` | agent loop, model router or injected provider, Permission Broker + SQLite store, audit log, memory (with flush), task engine + worker pool, scheduler (watches through `publicFetch` until S09's fetch), notifier; mounts package handlers; forwards package events to the bus; applies `permissions.policy` changes |
| `handlers.ts` | adapters from package handler maps to `HandlerDef`; `questions.*` over the loop and the task engine |
| `approval-tokens.ts` | in-memory delivery of single-use answer tokens to the caller's surface (security §3.7) |
| `file-tools.ts` | stand-in `read_file` / `write_file` / `list_dir` until P9 ships (#49) |
| `models.ts` | `PSYCHE_MODEL` → router config with env keys (dev and live tests); `NO_MODEL` |
| `services.ts` | `ComposeServices` handed to each part; `ComposedPart`; `ApprovalRelay` (approvals over chat) |
| `call-context.ts` | the loop's per-call decision context (thread, run, task, taint and its sources, requester, approval id, and `authorityFor`: the approval or standing grant that allowed the call) for package executors |
| `browser.ts` | bridge socket, `CdpBridgeDriver` per desktop, `browser.*` tools with per-task sessions and recordings, status pill, client `browser.*` methods |
| `connectors.ts` | `ConnectorRegistry` with Google, OAuth tokens in the vault (`VaultTokenVault`), disconnect on token revocation, sync timer, `connectors.list` / `get` |
| `vault.ts` | the S06 `Vault` (key slot per deployment: key file, safeStorage, or the keychain through the Mac helper), `vault.*` handlers without param logging, vault events as frames, the shared `SecretRedactor` and the masking logger |
| `channels.ts` | `ChannelService` with Telegram and WebChat, inbound → chat turns, replies, `channels.*`, approvals over chat |
| `helper.ts` | approvals on the Mac: cards to a connected helper as `notify.show`, `notify.response` → broker answers on the `notification` surface, the helper's Touch ID `PresenceVerifier` (signed assertion, #84) |
| `backup.ts` | `backup.list` / `create` / `verify` / `delete` with `@psyche/backup` (SQLite online backup, no downtime; restore stays in the CLI) and `logs.tail` over `logs/gateway*.log` with every line redacted (S22) |
| `proactive.ts` | S15 goals (`goals.*`) and the Feed (`feed.*`, sources from the `feed.sources` setting, the daily brief at 07:00); check-ins and briefs run in-process through `withProactiveJobs`; the heartbeat on a launcher bounded by `HEARTBEAT_TASK_BUDGET` (O2) |
| `proactive.ts` | S15 goals (`goals.*`), the Feed (`feed.*`, sources from the `feed.sources` setting, the daily brief at 07:00) and Ideas (`ideas.*`, mining at 02:30, delivery window at 09:00, accepted ideas as task cards in the main thread); check-ins, briefs and idea jobs run in-process through `withProactiveJobs`; the heartbeat on a launcher bounded by `HEARTBEAT_TASK_BUDGET` (O2) |
| `parts.ts` | the parts `psyched` mounts from its environment |

Approvals that need Touch ID or a passkey are refused until a verifier accepts a real assertion (fail closed): helper assertions need a registered presence key, which nothing registers yet (#84); passkeys need S01 (#79).

Status, gaps and timings: [docs/status/int-1.md](../../../../docs/status/int-1.md), [docs/status/int-2.md](../../../../docs/status/int-2.md).
