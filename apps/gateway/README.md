# @psyche/gateway (`psyched`)

**Owner:** S01 (`prompts/s01-gateway-core.md`). Feature ids: A2, A4 (retention), A5 (config subset), E1–E3, N14, D6 (restart recovery) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

The long-running Gateway that owns all state and exposes the typed WS/HTTP API (architecture §3.1, §4, §7, §11). Everything goes through `@psyche/protocol` (frames, methods, events, contracts) and `@psyche/db` (SQLite).

## Process model

One `psyched` per `$PSYCHE_HOME`. It binds loopback only, holds the SQLite database open, and is the only writer. Supervision (launchd on macOS, systemd on Linux, restart on crash) is S22's; the Gateway is safe to kill at any point: the next boot recovers (see "Restart recovery"). `SIGINT` / `SIGTERM` shut down gracefully: `gateway.shutdown` is broadcast, running turns are aborted, sockets close, the handshake secret is removed.

```bash
pnpm --filter @psyche/gateway start                  # run the Gateway
pnpm --filter @psyche/gateway start devices list     # local owner commands (below)
```

## Config keys

Precedence: overrides passed to `startGateway` → environment → `$PSYCHE_HOME/config.json` → defaults. Invalid `config.json` fails fast with a readable error; unknown `gateway.*` keys are errors. No secrets in config.

| Key | Env | Default | Notes |
| --- | --- | --- | --- |
| — | `PSYCHE_HOME` | `~/.psyche` | Created 0700 with `state/`, `run/`, `logs/` |
| `gateway.host` | `PSYCHE_HOST` | `127.0.0.1` | Non-loopback refused (security §10) |
| `gateway.publicOrigin` | `PSYCHE_PUBLIC_ORIGIN` | — | The https origin of the web client behind a proxy (`http://localhost` for development). Added to the allowed Origins; its host is the passkey RP ID |
| — | `PSYCHE_BIND` | `loopback` | `container` listens on the container interface (`src/transport-gate.ts`): trusted proxies need a verified identity (Cloudflare Access assertion, or Tailscale headers from `trustedProxy.tailscaleProxies`), every other peer the token. Pairing still applies |
| — | `PSYCHE_GATEWAY_TOKEN_FILE` | — | Required with `PSYCHE_BIND=container`: ≥ 32 characters, mode 0600/0400, owned by the Gateway's user, else startup fails. Presented as `Authorization: Bearer` |
| `gateway.port` | `PSYCHE_PORT` | `7979` | `0` = ephemeral |
| — | `PSYCHE_DB` | `state/psyche.sqlite` | `:memory:` in tests |
| — | `PSYCHE_NODE_SOCKET` | `run/node.sock` | Unix socket paths are limited to 103 bytes on macOS (107 on Linux): an explicit path that is too long fails naming the variable; a deep `$PSYCHE_HOME` falls back to `<tmpdir>/psyche-<uid>/<hash>.sock` (directory 0700, owner checked). The actual path is written to `run/node-socket` for local clients |
| — | `PSYCHE_WEB_ROOT` | `apps/web/dist` | Served at `/` with a strict CSP |
| `gateway.allowedOrigins`, `gateway.publicOrigin` | `PSYCHE_ALLOWED_ORIGINS` | `[]` | Extra WebSocket `Origin`s besides the Gateway's own |
| `gateway.trustedProxy.{enabled, trustedProxies}` | — | off | Tailscale Serve / `cloudflared` in front. From a peer in `trustedProxies` (CIDRs, validated at startup), the first untrusted `X-Forwarded-For` hop from the right is the client address (rate limits, pairing cards) and `Tailscale-User-Login` is shown on the pairing card as a claim. Headers never authorize: every device still pairs. Any request with forwarding headers is never treated as loopback, in either mode. Passkeys come later (INT-2) |
| `gateway.cloudflareAccess.{teamDomain, audience}` | — | off | `cloudflared` + Cloudflare Access in front: every forwarded or non-loopback WebSocket upgrade must carry a `Cf-Access-Jwt-Assertion` that verifies against `https://<teamDomain>/cdn-cgi/access/certs` (RS256, `aud` = the application AUD tag, `iss`, `exp`/`nbf`), else 401. The verified email is shown on the pairing card; it never authorizes by itself. JWKS refreshed at most every 5 minutes on an unknown key id |
| `gateway.rateLimits.{inboundChatPerMinute, fetchPerMinute}` | — | 30, 60 | Security §10 rate limits (integers 1-10000). Inbound chat counts per channel and sender before any policy runs, so unknown senders flooding pairing count too; a refused message is dropped. `web_fetch` counts per Task (per thread for interactive turns) and fails `rate_limited` before any request leaves. The first refusal per key and minute is audited as `rate_limit.exceeded` |
| — | `PSYCHE_LOG_LEVEL` | `info` | JSON logs on stderr, metadata only (no bodies, params or secrets) |

Settings (`settings.set`) that the Gateway reads: `cleanupPeriodDays` (default 30, admin-only like every non-cosmetic key).

## API surface

HTTP: `GET /healthz` (bare `{"ok":true}`), `GET /version`, the web UI at `/` (CSP `default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`). WebSocket at `/ws`; nodes on the Unix socket (NDJSON). Frames and the handshake follow wire spec v1 (`docs/plans/s00.md`).

| Family | Methods | Notes |
| --- | --- | --- |
| Handshake | `connect`, `connect.verify` | Ed25519 signed challenge, 60 s |
| Devices (`operator.admin`) | `devices.list`, `devices.pairing.list`, `devices.approve`, `devices.deny`, `devices.revoke` | Owner-chosen scopes; approve re-checks the key fingerprint and the optional `code` |
| Settings | `settings.get`, `settings.set` | Every key outside `USER_SETTING_PREFIXES` needs `operator.admin` |
| Threads | `threads.create`, `.list` (paged, `query`, activity counts), `.get`, `.rename`, `.archive`, `.restore`, `.pin`, `.delete`, `.fork` | One persistent main thread; incognito expires after 24 h |
| Chat | `chat.send`, `chat.steer`, `chat.followUp`, `chat.cancel`, `chat.history` (paged backwards), `chat.queue.list`, `chat.queue.remove`, `chat.export` (Markdown / JSON) | Queue modes below |
| Nodes | `nodes.list`, `nodes.capabilities`, `nodes.invoke`; node side `node.event`, `node.result` | Through the Permission Broker |
| Events | `events.subscribe` (`events` name/prefix patterns, `threadIds`) | Returns `stateVersion` |
| Speech | `voice.start`, `voice.push`, `voice.stop`, `voice.cancel`, `voice.memo.save`, `speech.readAloud`, `speech.voices` | S17's `@psyche/speech` handlers, mounted by the composition root (`src/compose/speech.ts`). Engine: the newest connected mac-helper node with `speech.*` (whisper.cpp / Kokoro when installed). `voice.*` / `speech.audio` events go to the requesting device only; its sessions end when its last connection closes. ffmpeg / whisper-cli run behind `PSYCHE_SPEECH_RUNNER_PREFIX` when set (e.g. `srt`) |
| Passkeys | `passkeys.register.begin`, `passkeys.register.finish`, `passkeys.reauth.begin`, `passkeys.list`, `passkeys.remove` | WebAuthn passkeys per device (`src/compose/passkeys.ts`, `@simplewebauthn/server`), only with an https `publicOrigin`. A passkey assertion is the `webauthn` presence on `approvals.answer`; once one is registered, security settings need a presence-approved `policy_change` card. Adding or removing a passkey on a device that has one needs a fresh assertion |
| Audit | `audit.list`, `audit.verify` (`operator.read`), `audit.export` (`operator.admin`) | S05's `@psyche/permissions` handlers over the hash-chained log, mounted by the composition root |

Every other registered method answers `not_implemented` (tasks, approvals, memory, … belong to other sessions and are wired in as they land).

`approval.created` carries `answerToken` per connection: the composition root's personalizer adds the token of the subscriber's own surface, only for devices holding `operator.approvals` (security §3.7, issue #50). `approvals.get` / `list` still return it for clients that reconnect.

Events emitted: `chat.message`, `chat.delta`, `chat.block`, `chat.queue.updated`, `run.updated`, `tool_call.updated`, `approval.created`, `question.created`, `receipt.created`, `thread.updated`, `thread.deleted`, `node.updated`, `device.updated` and `pairing.requested` (admin only), `settings.changed`, `gateway.shutdown`. Each carries `seq` (per process) and `stateVersion` (persisted, bumped in the transaction of each mutation). Events are not replayed; a client that sees a gap calls `events.subscribe` / the list methods and compares `stateVersion`.

## Auth and pairing

- `connect` → challenge → `connect.verify`. A paired device must present its pairing key and keeps its role; a revoked device is denied forever.
- **Loopback auto-pairing** needs loopback, no `Origin` and the per-launch secret in `run/handshake.secret` (0600). The desktop (`deviceFamily: desktop`, WebSocket only) gets `operator.read`, `operator.write`, `operator.approvals`, **never `operator.admin`**: the secret is a bearer token any same-user process can read (S23 review PR-1-A). The mac helper (`role: node`, `mac-helper`) gets `node`.
- The node socket accepts only `role: node`.
- Everything else creates a pairing request (5 min) carrying the key fingerprint (`sha256:<hex>` of the raw key), transport and remote address. A different key for a device id with a live pending request is denied (PR-1-B). The owner approves with `devices.approve` from an admin device, or on the machine:

  ```bash
  psyched devices list
  psyched devices approve <CODE> [scopes]     # default: every operator scope (first admin)
  psyched devices grant <deviceId> <scopes>
  psyched presence reset                      # after losing every passkey / helper key
  ```

  The approved device reconnects to pick up its scopes (the Gateway closes its pending connection).
- Rate limits (security §10): failed challenges 10/minute/address, new pairing requests 5/hour/address, at most 20 pending overall; a pending connection is closed when its request expires. Each paired device gets 600 requests and 120 side-effecting requests per minute across all its connections (`rate_limited`, retryable, `details.scope`); node-protocol frames are exempt. Approval answers (10/minute/identity) are limited by the Permission Broker, inbound chat (30/minute/sender) by channels.
- Fresh presence (`src/presence-gate.ts`, security §10): security settings, access-widening and destructive admin methods (`PRESENCE_METHODS`) and a device's first passkey need a presence-approved `policy_change` card once a verifier can verify (`approval_required` with `details.approvalId`, retry with `approvalId`). The state is sticky: after losing every verifier they fail `presence_required`; `psyched presence reset` on the machine clears it.
- Revoking a device (`devices.revoke`) also ends the standing grants it approved: the composition root passes `onDeviceRevoked` → `PsychePermissionBroker.revokeGrantsByDevice` (design-28).
- Rate limits (security §10): failed challenges 10/minute/address, new pairing requests 5/hour/address, at most 20 pending overall; a pending connection is closed when its request expires.
- WebSocket `Origin` must be the Gateway's own origin or configured; anything else is 403 before the upgrade. Proxy identity headers are never read.

## Session controller

`threads.active_writer_run_id` is the source of truth for "a turn is running"; every transcript append states the writer it expects (`@psyche/db` writer guard). `chat.send` on an idle thread records the user message, creates a run, claims the writer and starts `AgentLoop.startTurn`. Mid-turn, by `mode`:

- `followUp` (default): stored in the durable `chat_queue`; runs as its own turn after the current one settles; listed by `chat.queue.list`, removable by `chat.queue.remove`. The queued id becomes the user message id.
- `steer`: recorded under the active run and passed to `AgentLoop.steer`.
- `interrupt`: the active run is cancelled, a new run supersedes it as the writer, and anything the old run still tries to commit is rejected.

`chat.cancel` revokes the run's authority (`AgentLoop.cancel` + `PermissionBroker.revokeRunAuthority`), waits up to 2 s for the agent to end, then force-finishes the run. Agent events map to `chat.delta` / `chat.block` / `tool_call.updated` / `approval.created` / `question.created` / `run.updated`; agent messages commit at message boundaries and at `end`. `tool_call` events with `details` persist full `tool_calls` rows.

## Cross-thread awareness (E12, opt-in)

With the admin setting `threads.crossThreadAwareness: true`, the composition root registers four agent tools (`src/compose/thread-tools.ts`): `threads_list` and `thread_read` (another thread's content is `untrusted` data; incognito threads are invisible), `thread_message` (queued as a follow-up recorded with `agent` provenance, never steering or interrupting; refused from a tainted turn) and `thread_archive` (always asks: `destructive`, approval kind `archive_thread`). Turning the setting off unregisters them.

## Restart recovery

On boot (`src/recovery.ts`): runs still `running` fail with `gateway_restart`, their writers are released and a system note is appended; tool calls `pending` / `running` become `uncertain` and are never re-dispatched; nodes are marked offline; the broker re-issues approvals (`PermissionBroker.reissue`); queued follow-ups drain. Idempotency results live in SQLite (`gateway_idempotency`, written in the same transaction as the mutation), so a retry after a crash replays the original result.

## Retention

Hourly (`src/retention.ts`): level-3 tool payloads (`tool_payloads`) older than `cleanupPeriodDays`, expired incognito threads (`thread.deleted` is emitted), idempotency results older than 7 days. Receipts and audit entries are never touched.

## Public API (`src/index.ts`)

`startGateway(options) → Gateway` (options: `config`, `env`, `logger`, `now`, `db`, `agent`, `broker`, `memory`, `limits`, `retentionIntervalMs`), `resolveConfig`, `readConfigFile`, `SessionController`, `NodeRegistry` (live nodes as `NodeClient`s), `recoverAfterRestart`, `runRetention`, `keyFingerprint`, `DESKTOP_AUTO_SCOPES`, the placeholders `UnavailableAgentLoop` and `LockedPermissionBroker`.

## Stubbed

- No real agent or broker yet: `psyched` runs with `UnavailableAgentLoop` (every turn fails cleanly) and `LockedPermissionBroker` (reads allowed, side effects denied) until S02 and S05 are wired in. Tests use the fakes.
- Fresh user presence for admin settings (Touch ID / passkey): not enforced (S14, INT-2).
- Peer code-signature check for the desktop (design-19): needs native code; the secret path is capped instead.
- `task.updated` / `notification.*` forwarding: `TaskEngine` and `Notifier` have no stream the Gateway consumes yet.
- `alsoForget` on `threads.delete` stages `MemoryStore.forget(dryRun)` only.
- Backups (`psyche backup`), `config` migration (`psyche doctor --fix`): S22.

## Layout

`src/server.ts` (lifecycle, HTTP, WS, Unix socket), `src/connection.ts` (handshake state machine, dispatch, idempotency, transactions, Gateway → peer requests), `src/auth.ts`, `src/handlers/*` (one file per method family), `src/session/controller.ts`, `src/nodes/registry.ts`, `src/recovery.ts`, `src/retention.ts`, `src/idempotency.ts`, `src/event-bus.ts`, `src/config.ts`, `src/cli.ts`, `src/defaults.ts`. Tests: `test/pairing.test.ts` (auth matrix), `test/chat.test.ts` (session controller, threads), `test/nodes.test.ts` (fake node over the real socket, `test/fake-node.ts`), `test/restart.test.ts` (SIGKILL mid-turn), `test/retention.test.ts`, `test/load.test.ts` (10 threads).
