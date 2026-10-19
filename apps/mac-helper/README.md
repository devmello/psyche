# Psyche Helper (apps/mac-helper)

**Owner:** S14 (`prompts/s14-mac-helper.md`). Feature ids: A9, J1–J7, J9, O10, Q1 engines, G1, L1–L5 in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

The signed Swift helper (`Psyche Helper.app`, bundle id `com.psyche.helper`, ADR-001/ADR-020) that
connects to the Gateway as a **node** (architecture §6, §7). Not a pnpm package: there is no
`package.json` here and the root vitest config excludes this directory.

## Status

Bootstrap skeleton from S00. `psyche-helper` connects to the Gateway's node socket, sends
`req connect` as `role: "node"` with an empty capability list, logs the challenge, signs it and
sends `connect.verify`, then logs the resulting phase and exits.

## Build, test, run

```sh
swift build --package-path apps/mac-helper
swift test  --package-path apps/mac-helper          # Swift Testing: framing, signing payload, handshake
apps/mac-helper/.build/debug/psyche-helper [--timeout 10] [--challenge-only]
```

Requires macOS 15+ (`platforms: [.macOS(.v15)]`, ADR-016) and Swift 6 tools. Run a Gateway first
(`apps/gateway`); the helper connects to `$PSYCHE_NODE_SOCKET`, else `$PSYCHE_HOME/run/node.sock`
(`$PSYCHE_HOME` defaults to `~/.psyche`). With no socket it exits 2 with a clear message. Exit codes:
0 done (paired or pending), 2 socket missing, 3 denied, 4 timeout, 1 other, 64 usage.

## Layout

| Target | What |
| --- | --- |
| `PsycheProtocol` (library) | `PsycheProtocol.generated.swift` (written by `pnpm protocol:gen` from `packages/protocol`; do not edit) and hand-written `Frames.swift`: `JSONValue`, `WireReqFrame` / `WireResFrame` / `WireEventFrame` / `WireFrame`, `WireConnectParams`, `WireConnectChallenge`, `WireConnectVerifyParams`, `WireConnectResult`. Hand-written names carry the `Wire` prefix so they never collide with generated ones. Compiled in Swift 5 language mode because the quicktype output is not Sendable-clean yet. |
| `PsycheHelperCore` | `NDJSONLineBuffer` (one frame per line, 1 MiB max), `ConnectSigning.payload`, `Base64URL`, `DeviceIdentity` (CryptoKit `Curve25519.Signing`), `UnixSocketConnection` (POSIX AF_UNIX, poll-based timeouts), `HelperPaths`, `NodeHandshakeClient`, `HelperLog` (`os.Logger`, subsystem `com.psyche.helper`). |
| `PsycheHelper` → `psyche-helper` | CLI entry (`main.swift`): flags, timeout, exit codes. |
| `Tests/PsycheHelperCoreTests` | NDJSON split/merged/oversized lines; signing payload bytes and SHA-256 against the shared TS fixture; frame round trips; full handshake against a fake Gateway over `socketpair`. |
| `Support/` | `Info.plist` and `PsycheHelper.entitlements` placeholders (bundle id, `LSUIElement`, usage descriptions TODO, hardened-runtime note). Not wired into SwiftPM. |

## Wire (docs/plans/s00.md "Wire spec v1")

```
→ {"type":"req","id":"connect","method":"connect","params":{"protocolVersion":{"min":1,"max":1},"deviceId":"dev_…","publicKey":"<b64url raw Ed25519>","role":"node","platform":"macos","deviceFamily":"mac-helper","name":"Psyche Helper","capabilities":[],"handshakeSecret":"<if $PSYCHE_HOME/run/handshake.secret exists>"}}
← {"type":"res","id":"connect","ok":true,"payload":{"phase":"challenge","nonce":"…","serverOrigin":"…","protocolVersion":1,"expiresAt":"…"}}
→ {"type":"req","id":"connect.verify","method":"connect.verify","params":{"nonce":"…","signature":"<Ed25519 over connectSigningPayload>"}}
← {"type":"res","id":"connect.verify","ok":true,"payload":{"phase":"paired"|"pending"|"denied",…}}
```

`connectSigningPayload` is the UTF-8 of `"psyche-connect-v1\n" + nonce + "\n" + platform + "\n" + deviceFamily + "\n" + protocolVersion + "\n" + serverOrigin`.
Logs contain phases and sizes only (`phase=challenge nonceBytes=32 protocolVersion=1`); never the
nonce, signature, secret or keys.

## Stubbed / for S14

- Device key is generated in memory per run (a new device each launch). S14 stores it in the data-protection keychain (security §4).
- No capability manifest, `node.invoke` handling, `node.event` / `node.result`, reconnects or long-running mode; the process exits after the handshake.
- `.app` bundling, Developer ID signing, hardened runtime, notarization, launchd plist and TCC flows are S14's; `Support/` holds placeholders only.
- Generated Swift models come from `packages/protocol` codegen (`pnpm protocol:gen`); the hand-written `Wire*` envelopes can be dropped once the generated frame types cover them.
