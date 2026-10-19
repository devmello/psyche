# Session S01 — Gateway core

You are building Psyche (read `README.md`). You are session **S01 — Gateway core**: the long-running `psyched` process that owns all state and exposes the typed WS/HTTP API. Work in your own worktree on branch `ws/s01-gateway-core`. You own `apps/gateway/**` and the evolution of `packages/db/**` (schema, migrations, query helpers) for the tables below.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §3.1, §4.1, §4.2 (request lifecycle), §4.12, §7, §11, §12
3. `docs/04-data-model.md` §1, §2, §11, §12
4. `docs/05-security-and-permissions.md` §10 (control plane and remote access)
5. `docs/03-feature-spec.md` rows A2, A4, A5, E1–E3 (persistence and queue semantics), N14, D6
6. `packages/protocol` (frames, methods, events, contracts) and `packages/testing` fakes
7. Research: `research_notes/Psyche personal agent landscape/opendots_openclaw_harnesses.md` §2b, §2c, §2d (OpenClaw's gateway protocol, session controller, writer guard) and `claude_desktop_and_peers.md` Q7 (IPC patterns)

## Mission (M1)
- **Server**: WS + HTTP on `127.0.0.1:7979` (configurable), frames `req/res/event`, `seq`/`stateVersion` on every event, `stateVersion`-based refresh for clients that missed events, idempotency keys on side-effecting methods (store and replay results), graceful shutdown, structured logs without bodies.
- **Auth and pairing**: device identity (Ed25519) with signed challenge nonce on `connect`; loopback connects may auto-pair; everything else creates a `pairing_request` the owner approves via `devices.approve`; scoped device tokens (`operator.read|write|approvals|admin`, `node`); WebSocket Origin validation; the UI never passes a gateway URL parameter; identity headers from a trusted proxy never authorize by themselves (trusted-proxy mode is a config flag that only unlocks passkey/WebAuthn login for the web client, implemented later by INT-2).
- **Session controller**: per-thread turn serialization; queue modes `steer | followUp | interrupt`; `activeWriterRunId` on the thread and `expectedWriterRunId` on every transcript write; cancellation revokes the run's tool authority through the `PermissionBroker` interface.
- **Threads and messages**: implement `threads.*` (create main/side/incognito, list, rename, archive/restore, delete, pin, search by title), `chat.send` (attachments by Library id), `chat.fork` (copy transcript up to a message, record lineage), `chat.steer`, `chat.followUp`, `chat.cancel`, `chat.history` (paged), `chat.export` (Markdown). Persist blocks per `docs/04-data-model.md` §9.1 and provider-native turns opaquely.
- **Wiring**: drive the `AgentLoop` contract (fake until S02 merges) and forward its events as `chat.delta`, `tool_call.*`, `approval.created`, `question.created`, `task.updated`, `receipt.created`. Expose `events.subscribe` with filters.
- **Static UI**: serve `apps/web` build at `/` with correct CSP; `GET /healthz`, `GET /version`.
- **Node registry**: `nodes.*` methods (list, capabilities, invoke with approvalId passthrough) per architecture §7, with the mac helper as the first client (S14) and a fake node in tests.
- **Retention**: `cleanupPeriodDays` job for level-3 tool payloads; incognito thread expiry.

## Out of scope
Agent logic (S02), model calls (S03), task engine internals (S04), policy decisions (S05), UI (S11/S12), channels (S10), CLI (C2).

## Interfaces
- You consume via fakes: `AgentLoop`, `TaskEngine`, `PermissionBroker`, `MemoryStore`, `Notifier`, `SearchIndex`.
- You expose: the WS API exactly as `packages/protocol` defines it; add methods/events only through `protocol:` PRs.

## Definition of done
- Contract tests: pairing (loopback auto, remote approval, revoked token, bad signature, bad Origin), idempotent `chat.send`, event ordering and `stateVersion` refresh, fork lineage, writer guard rejecting a superseded run, restart mid-turn (process killed between model events) leaving a consistent transcript with no duplicated side effects, retention job.
- Load test: 10 concurrent threads streaming without cross-talk.
- `apps/gateway/README.md` documents config keys, the process model (launchd/systemd handled by C2), and the API surface; `docs/status/s01.md` updated.

## Suggested plan and subagents
Plan file → server + frames → pairing/auth → session controller → threads/messages → agent wiring → nodes → retention. Subagents: one to write the pairing/auth test matrix, one to build the fake-node harness, one to review the diff for the security doc's control-plane rules.

## M2 follow-ons (in order)
Cross-thread awareness methods (E12) gated by approval; trusted-proxy header mode; `audit.*` query methods over `packages/audit`; rate limits per device token.
