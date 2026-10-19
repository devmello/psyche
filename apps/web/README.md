# @psyche/web

**Owner:** S11 (`prompts/s11-desktop-web-shell.md`). Feature ids: A8, Q1 UI in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

The same React app as the desktop renderer, served by the Gateway at `/`.

## Status

Bootstrap hello page from S00: "Psyche", Gateway health (`fetch("/healthz")`) and the pairing
phase. Browser connections are never auto-approved (security §10), so against a fresh Gateway it
shows **pending pairing** with the code to approve from a paired device.

## Run

```sh
pnpm --filter @psyche/web dev        # Vite on http://127.0.0.1:5173, proxies /healthz and /ws to 127.0.0.1:7979
pnpm --filter @psyche/web build      # → apps/web/dist (gitignored); the Gateway serves it at /
pnpm --filter @psyche/web test       # vitest (URL builder, handshake signing)
pnpm --filter @psyche/web typecheck
```

When built, the Gateway serves `apps/web/dist` at `http://127.0.0.1:7979/` (Vite `base: "/"`).

## Gateway connection

- **Only `location.origin`** (security §10, ADR-015, CVE-2026-25253): `src/lib/ws-url.ts` builds
  `new URL("/ws", location.origin)` with `http→ws` / `https→wss`. It takes the origin alone, so
  `location.search` and `location.hash` can never supply a Gateway address or token
  (`test/ws-url.test.ts` asserts this). No deep-link or query parameter is read anywhere.
- Frames (wire spec v1, docs/plans/s00.md): `req connect {protocolVersion:{min:1,max:PROTOCOL_VERSION}, deviceId, publicKey, role:"client", platform:"web", deviceFamily:"web", name:"Psyche Web"}` (no `handshakeSecret`), then on the challenge `req connect.verify {nonce, signature}` where the signature is WebCrypto Ed25519 over `connectSigningPayload`. Reconnects with exponential backoff.
- CSP meta: `default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; ...`. The dev server alone relaxes `script-src` for the React refresh preamble. The dev proxy maps the Origin of upgrades from the dev page (only) to the Gateway's own origin; other origins pass through and are rejected by the Gateway.

## Stubbed / for S11

- Device key: an in-memory WebCrypto Ed25519 pair with a non-extractable private key; no IndexedDB yet, so every reload is a new device and a new pairing request. S11 persists it (IndexedDB, non-extractable `CryptoKey`) and adds passkey login (INT-2).
- `src/lib/{frames,signing,handshake,status,backoff}.ts` duplicate `apps/desktop/src/lib`; replace with `@psyche/protocol` frame helpers and one shared client module.
- No RPC after the handshake; events are ignored. The bundle includes all of `@psyche/protocol` (TypeBox) for `PROTOCOL_VERSION`.
