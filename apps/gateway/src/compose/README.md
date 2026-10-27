# Gateway composition root (INT-1, INT-2)

`composeGateway(options)` builds the real services and starts `psyched` with them; `main.ts` calls it. Owned by the integration sessions (INT-1..3), not S01.

| File | What it wires |
| --- | --- |
| `index.ts` | agent loop, P9 file tools from `@psyche/files` (#49), model router or injected provider, Permission Broker + SQLite store, audit log, memory (with flush), task engine + worker pool, scheduler (watches through `publicFetch` until S09's fetch), notifier; mounts package handlers; forwards package events to the bus; applies `permissions.policy` changes |
| `handlers.ts` | adapters from package handler maps to `HandlerDef`; `questions.*` over the loop and the task engine |
| `approval-tokens.ts` | in-memory delivery of single-use answer tokens to the caller's surface (security §3.7) |
| `models.ts` | `PSYCHE_MODEL` → router config with env keys (dev and live tests); without it `vaultModelSetup` (hosted keys from the vault); `NO_MODEL` |
| `model-keys.ts` | Hosted provider keys as Gateway-owned vault items (`models.setKey`), the router's `KeySource` over them, and the "no model picked yet" reply |
| `services.ts` | `ComposeServices` handed to each part; `ComposedPart`; `ApprovalRelay` (approvals over chat) |
| `call-context.ts` | the loop's per-call decision context (thread, run, task, taint and its sources, requester, approval id, and `authorityFor`: the approval or standing grant that allowed the call) for package executors |
| `browser.ts` | bridge socket, `CdpBridgeDriver` per desktop, `browser.*` tools with per-task sessions and recordings, status pill, client `browser.*` methods |
| `connectors.ts` | `ConnectorRegistry` with Google, OAuth tokens in the vault (`VaultTokenVault`), disconnect on token revocation, sync timer, `connectors.list` / `get` |
| `vault.ts` | the S06 `Vault` (key slot per deployment: key file, safeStorage, or the keychain through the Mac helper), `vault.*` handlers without param logging, vault events as frames, the shared `SecretRedactor` and the masking logger |
| `channels.ts` | `ChannelService` with Telegram and WebChat, inbound → chat turns, replies, `channels.*`, approvals over chat |
| `computer.ts` | computer use for the agent (J1–J5) on the Mac helper node: `computer.snapshot` / `act` / `screenshot`, `apps.list` / `open` / `focus` / `applescript` / `shortcut_run` / `shortcuts_list` with app targets (per-app tiers and rules), `apple_script` / `shortcut_run` approval kinds, untrusted output; the helper's "Ask" and risky-label requests become `computer_action` approvals bound to the call; one session per Task (or run) named on every `computer.*` call and ended with the run or Task; Esc on the Mac cancels the run. Registered only while `computerUse.enabled` is on |
| `helper.ts` | approvals on the Mac: cards to a connected helper as `notify.show`, `notify.response` → broker answers on the `notification` surface, the helper's Touch ID `PresenceVerifier` (signed assertion, #84) |
| `backup.ts` | `backup.list` / `create` / `verify` / `delete` with `@psyche/backup` (SQLite online backup, no downtime; restore stays in the CLI) and `logs.tail` over `logs/gateway*.log` with every line redacted (S22) |
| `proactive.ts` | S15 goals (`goals.*`) and the Feed (`feed.*`, sources from the `feed.sources` setting, the daily brief at 07:00); check-ins and briefs run in-process through `withProactiveJobs`; the heartbeat on a launcher bounded by `HEARTBEAT_TASK_BUDGET` (O2) |
| `proactive.ts` | S15 goals (`goals.*`), the Feed (`feed.*`, sources from the `feed.sources` setting, the daily brief at 07:00) and Ideas (`ideas.*`, mining at 02:30, delivery window at 09:00, accepted ideas as task cards in the main thread); the agent's `goals.*`, `ideas.*` and `feed.*` tools are registered in the loop's registry (reads allow, changes ask); check-ins, briefs and idea jobs run in-process through `withProactiveJobs`; the heartbeat on a launcher bounded by `HEARTBEAT_TASK_BUDGET` (O2) |
| `meetings.ts` | Post-meeting notes and Record meeting (`meetings.*`, mail and meetings §4.6): notes from a Library recording or a consented recording, transcribed on the Mac through the speech part (`speech.transcribe_file`), "they owe you" loops into the people graph; the graph hooks of meeting prep (§4.5: attendees and open loops) |
| `parts.ts` | the parts `psyched` mounts from its environment |

Approvals that need Touch ID or a passkey are refused until a verifier accepts a real assertion (fail closed): helper assertions need a registered presence key, which nothing registers yet (#84); passkeys need S01 (#79).

Status, gaps and timings: [docs/archive/status/int-1.md](../../../../docs/archive/status/int-1.md), [docs/archive/status/int-2.md](../../../../docs/archive/status/int-2.md).
