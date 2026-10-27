# pr-1: S00 bootstrap, Gateway auth and protocol scopes

**PR:** devmello/psyche#1 (`ws/s00-bootstrap`, reviewed at `origin/ws/s00-bootstrap` on 2026-10-19). **Scope reviewed:** `apps/gateway/src/{auth,connection,server,http,config,home,event-bus}.ts`; `packages/protocol` method scopes, `isAdminSettingKey`, `PairingRequest`, bridge protocol. **Docs:** 05 §10, §3.7; 02 §11; wire spec v1 in `docs/plans/s00.md`.
**Failing tests:** `tests/corpus/review-cases/pr-1/gateway-auth.test.ts`. Run it with `pnpm exec vitest run --config tests/corpus/review-cases/vitest.config.ts pr-1`. On the PR head: **18 fail** (findings), **11 pass** (held), 5 todo.

## What broke

**A. High: loopback auto-pairing gives `operator.admin` to any same-user process.** `autoPairScopes` grants all `OPERATOR_SCOPES` to a connection that is loopback, has no `Origin`, presents `run/handshake.secret` and *claims* `deviceFamily: "desktop"`. The secret file is 0600, which means readable by every process the owner runs. The test reads it and gets `phase: "paired"` with admin over WS, and also over the **node Unix socket** with `role: "client"`. 05 §1.3 says A6 is protected against same-user malware; this path does not protect it (design-19).
*Fix:* never accept `role: client` on `node.sock`. Move desktop auto-pairing to a Unix socket and authenticate the peer by code signature (`LOCAL_PEERTOKEN` → `SecCode` designated requirement) instead of a bearer file. Until then, cap auto-pair scopes at `operator.read` + `operator.write` and require the owner to confirm admin on first launch.

**B. Medium: a pending device id can be taken over by another key.** `verifyChallenge` expires the pending request and **overwrites the device row's `publicKey`** when the same `deviceId` returns with a different key. The attacker gets a fresh request with the same display ("Pranav's iPhone (macos, desktop)"). `devices.approve` takes only `pairingRequestId`, and `PairingRequest` has no key fingerprint, so the owner cannot tell the two apart and approves the attacker's key.
*Fix:* derive `deviceId` from the public key (for example `base32(sha256(pk))[:26]`); refuse a different key for a live pending id (`denied: device id in use`). Store `publicKeyFingerprint`, remote address and transport on `PairingRequest`, show them on the card, and have `devices.approve` require the code displayed on the new device.

**C. High: `ADMIN_SETTING_ROOTS` misses security settings.** The roots are `permissions, exec, vault, devices, gateway, channels, grants, approvals`. Not covered: `commands.ownerAllowFrom` (owner identity: an `operator.write` device adds its own Telegram id as owner and then answers approvals), `identityLinks`, `session.dmScope`, `mcp.*` / `connectors.*` (add a server or flip an action matrix), `skills.*`, `plugins.*`, `models.*` (05 §7.3: auto mode allowlist), `updates.*`, `browser.*` (real-Chrome debug port), `vm.*` (rw shares, clipboard), `memory.*` (sensitive filters) and `backup.*`.
*Fix:* turn it into an allowlist. Every key is admin unless it is on a short list of cosmetic roots (`appearance`, `ui`, `notifications.sound`, …), and add a test that every key in the config schema is classified.

## Protocol notes (no test yet; for S01, S08, S11)

- **Bridge.** `bridge.hello` authenticates the desktop with the same bearer secret. Whoever completes it receives every `bridge.cdp.send`, including `Input.insertText` carrying **plaintext credential fills** (05 §4.6). A same-user process that wins the race to `browser-bridge.sock` is a credential sink. Use the same peer-code-signature check as in A. The desktop should also allowlist CDP domains (no `Runtime.evaluate` / `Target.*` / `Storage.*` / `Network.getAllCookies` from the Gateway outside the localhost exception).
- **`nodes.invoke`** is open to any `operator.write` client "through the Permission Broker", which is not implemented yet. The helper's `vault.unlock` / `keychain.*` must be unreachable through it (02 §6, 05 §4.3). Recorded as a todo test.
- **`approvals.answer`** (`ApprovalAnswer`) has no field for a presence assertion. Adding one later is additive; see design-04.

## What held

- The WS `Origin` allowlist rejects `null`, the empty string, a DNS-rebinding origin and a `localhost` / `127.0.0.1` mismatch with 403 before the upgrade.
- A same-origin browser connection is never auto-paired, even when it has the secret.
- The non-loopback bind is refused (`0.0.0.0`, `::`, a LAN address, `::ffff:127.0.0.1`, `127.0.0.2`).
- Methods called before pairing → `not_paired`.
- The signing payload includes `serverOrigin` (no relay to another port).
- Revoked devices are denied, and a paired device's key and role are pinned.
- Idempotency is keyed per device.
- `settings.set` rejects `_`-prefixed internal keys and lowercases the root before the admin check.
- Static files: path traversal is contained; strict CSP with `frame-ancestors 'none'`, `connect-src 'self'`.
- `$PSYCHE_HOME` is 0700, and the socket and secret are 0600.

**Verdict:** A and C should be fixed or tracked as S01 blockers before any client beyond the desktop is paired. B can land with S01's `devices.approve`.
