# @psyche/desktop

**Owner:** S11 (`prompts/s11-desktop-web-shell.md`). Feature ids: A6, A7, E10, I1, I5, I6, I11, K6, D5 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

Electron 44 desktop shell (`Psyche.app`, ADR-020): panes, embedded browser pane host, terminal pane, settings shell.

## Status

Bootstrap hello window from S00. It shows "Psyche", the Gateway health (`GET /healthz`) and the
device pairing phase. Everything else is S11's.

## Run

```sh
pnpm --filter @psyche/desktop start      # electron-forge start (Vite dev server + Electron)
pnpm --filter @psyche/desktop test       # vitest: pure logic in src/lib, plain Node, no Electron
pnpm --filter @psyche/desktop typecheck  # main, preload, renderer, tests and the Forge/Vite configs
pnpm --filter @psyche/desktop package    # electron-forge package (unsigned)
```

Start a Gateway first (`apps/gateway`, `ws://127.0.0.1:7979/ws`). With the Gateway's per-launch
`$PSYCHE_HOME/run/handshake.secret` readable, the desktop auto-pairs over loopback; otherwise it
shows "pending pairing" with the code to approve.

## Layout

| Path | Process | What |
| --- | --- | --- |
| `src/main.ts` | main | single `BaseWindow` hosting the renderer in a `WebContentsView`; sandbox, permission and navigation lockdown; IPC handlers |
| `src/gateway-client.ts` | main | `/healthz` polling and the WS handshake, reconnect with backoff |
| `src/preload.ts` | preload | `window.psyche.getStatus()` / `onStatus(cb)` via `contextBridge` |
| `src/renderer/` | renderer | `index.html` (CSP meta), `main.tsx`, `App.tsx` using `@psyche/ui` placeholders |
| `src/lib/` | any | pure logic: frames, signing payload, handshake state machine, status reducer, backoff, device key |
| `test/` | Node | vitest unit tests for `src/lib` |

## Gateway connection (wire spec v1, docs/plans/s00.md)

The **main process** connects; the renderer only ever receives `GatewayStatus` (health, phase,
pairing code, negotiated version, error code). It never sees the handshake secret, the device key
or any token.

1. `GET http://127.0.0.1:7979/healthz` every 10 s → `health: ok | unreachable`.
2. `new WebSocket("ws://127.0.0.1:7979/ws")` (Node's global WebSocket; it sends no `Origin`).
3. `{"type":"req","id":"connect","method":"connect","params":{protocolVersion:{min:1,max:PROTOCOL_VERSION}, deviceId, publicKey, role:"client", platform:"macos"|"linux", deviceFamily:"desktop", name, handshakeSecret?}}`
4. On the `challenge` result, sign `connectSigningPayload` (`"psyche-connect-v1\n" + nonce + "\n" + platform + "\n" + deviceFamily + "\n" + protocolVersion + "\n" + serverOrigin`) with Ed25519 and send `{"type":"req","id":"connect.verify","method":"connect.verify","params":{nonce, signature}}`.
5. `paired` / `pending` (shows the code) / `denied` (stops reconnecting). On close: exponential backoff (0.5 s doubling to 30 s, 50 % jitter).

## Security settings

- Renderer: `contextIsolation`, `sandbox: true` (plus `app.enableSandbox()`), `nodeIntegration: false`, no `<webview>`, no remote module; the preload exposes two functions only and IPC handlers check the sender frame URL.
- `setWindowOpenHandler` denies every popup; `will-navigate` blocks anything but the app entry; all permission requests and checks are denied.
- CSP meta in `src/renderer/index.html`: `default-src 'self'; script-src 'self'; connect-src 'self' ws://127.0.0.1:7979 http://127.0.0.1:7979; object-src 'none'; ...`. The dev server (only) relaxes `script-src` for the React refresh preamble and allows the Vite HMR socket (`devCsp()` in `vite.renderer.config.ts`).
- Fuses (`forge.config.ts`, applied at package time): `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `EnableCookieEncryption` on; `asar: true`.
- No telemetry, no crash reporter (ADR-017).
- Bundle id `com.psyche.desktop`. Signing and notarization are commented placeholders in `forge.config.ts` reading `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD` from the environment; CI builds unsigned.

## Stubbed / for S11

- Device key: `userData/device-key.json` (mode 0600, Ed25519 JWK). Move it to the keychain / `safeStorage` (S06, security §4).
- Frame helpers in `src/lib/frames.ts` and `signing.ts` duplicate `@psyche/protocol`; switch to the protocol package's `parseFrame` / `connectSigningPayload` once they land.
- Renderer loads from `file://` in packaged builds; S11 moves it to a custom `app://` scheme and then disables the `GrantFileProtocolExtraPrivileges` fuse.
- Events after pairing are ignored; no RPC beyond the handshake; no menu-bar item, panes, browser host, LaunchAgent or Gateway spawning.
- The Gateway address is fixed to `http://127.0.0.1:7979` (no URL parameters or deep links, security §10).
