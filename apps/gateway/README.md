# @psyche/gateway (`psyched`)

**Owner:** S01 (`prompts/s01-gateway-core.md`); bootstrap skeleton by S00. Feature ids: A2, A4, A5, E1–E3, N14, D6 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

The long-running Gateway that owns all state and exposes the typed WS/HTTP API (architecture §3.1, §4, §11).

## What the bootstrap skeleton does

- Binds `127.0.0.1:7979` only; a non-loopback host is refused at startup (security §10).
- Creates `$PSYCHE_HOME` (default `~/.psyche`) with `state/`, `run/`, `logs/` at mode 0700 and opens `state/psyche.sqlite` through `@psyche/db` (WAL, migrations).
- HTTP: `GET /healthz` → `{"ok":true}` (bare, unauthenticated), `GET /version`, and the built web UI (`apps/web/dist`) at `/` with a strict CSP and SPA fallback.
- WebSocket at `/ws`: `Origin` validated on upgrade (403 outside the Gateway's own origin plus `PSYCHE_ALLOWED_ORIGINS`), `req`/`res`/`event` frames from `@psyche/protocol`.
- Unix socket for local nodes at `$PSYCHE_HOME/run/node.sock` (0600), newline-delimited JSON frames.
- Handshake: `connect` → 32-byte challenge (60 s) → `connect.verify` with an Ed25519 signature over the spec's signing payload. Loopback auto-pairing only for the desktop (`role: client`, `deviceFamily: desktop`) and the helper (`role: node`, `deviceFamily: mac-helper`) presenting the per-launch secret in `$PSYCHE_HOME/run/handshake.secret` (0600) and no `Origin` header. Everything else gets a pending pairing request (5 min). Known devices re-pair by key; a key mismatch or revoked device is denied.
- Methods: `connect`, `connect.verify`, `settings.get`, `settings.set` (idempotency key required; security-sensitive key prefixes need `operator.admin`). Every other registered method answers `not_implemented`.
- Event bus: every event carries `seq` (per process) and `stateVersion` (persisted, bumped in the same transaction as each mutation). `settings.set` emits `settings.changed`.
- Graceful shutdown on SIGINT/SIGTERM (emits `gateway.shutdown`, closes sockets, removes the handshake secret).
- Structured JSON logs to stderr without bodies or params.

## Run

```bash
pnpm --filter @psyche/gateway start
```

Environment: `PSYCHE_HOME`, `PSYCHE_PORT` (0 = ephemeral), `PSYCHE_DB`, `PSYCHE_NODE_SOCKET`, `PSYCHE_WEB_ROOT`, `PSYCHE_ALLOWED_ORIGINS` (comma-separated), `PSYCHE_LOG_LEVEL`.

## Stubbed (S01's M1 scope)

Owner approval of pending pairings (`devices.approve`), scoped tokens and their storage, fresh user presence for admin settings, threads/chat/session controller, agent wiring, node registry and `nodes.invoke`, `events.subscribe` filters (every paired connection currently receives every event), persisted idempotency results (in memory today), rate limits, `config.json` (A5), retention jobs, launchd/systemd supervision (C2).

## Layout

`src/config.ts` (env → config, loopback guard), `src/home.ts` (directories, handshake secret), `src/server.ts` (HTTP, WS, Unix socket, lifecycle), `src/connection.ts` (handshake state machine, dispatch, scopes, idempotency, settings), `src/auth.ts` (challenge, signature check, auto-pair rules), `src/event-bus.ts`, `src/store.ts` + `src/db-store.ts` (the only file that knows `@psyche/db`), `src/http.ts`, `src/transports/ndjson.ts`.
