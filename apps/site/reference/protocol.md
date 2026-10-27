---
title: Protocol
---

# Protocol

Every client of Psyche, including the desktop app, the web UI, the CLI and the Mac helper, talks to the Gateway (`psyched`) over one typed protocol: JSON request, response and event frames over a WebSocket. This page is an overview for people who want to build a client or a node. It explains the transport, pairing, scopes, the method and event families, and nodes. The schemas themselves live in [packages/protocol](https://github.com/devmello/psyche/tree/main/packages/protocol); this page links to them rather than copying them.

## Transport

- **Clients** connect to `ws://127.0.0.1:7979/ws`, one JSON frame per text message. The Gateway listens on loopback only. Remote clients reach it through Tailscale Serve, Cloudflare Access or an SSH tunnel; see [server mode](/guides/server-mode).
- **Local nodes**, such as Psyche Helper, connect over the Unix socket `$PSYCHE_HOME/run/node.sock` (mode 0600) with newline-delimited JSON.
- **HTTP** on the same port: `GET /healthz` returns `{"ok":true}` without authentication, and `GET /version` returns the name, version and protocol version.
- The largest frame is 1 MiB.

The WebSocket handshake rejects any `Origin` outside the Gateway's own origin, the configured public origin and the app scheme. The web UI connects only to the origin it was served from; no client accepts a Gateway address from a URL parameter or a deep link.

## Frames

The protocol is JSON-RPC in spirit, with its own envelope ([src/frames.ts](https://github.com/devmello/psyche/blob/main/packages/protocol/src/frames.ts)):

```ts
{ type: "req",   id, method, params?, idempotencyKey? }
{ type: "res",   id, ok: true,  payload }
{ type: "res",   id, ok: false, error: { code, message, details?, retryable? } }
{ type: "event", event, payload, seq, stateVersion }
```

- Envelopes are closed: unknown keys are rejected. Params, results and event payloads are validated against the method and event registry.
- Methods marked side-effecting require an `idempotencyKey`. Repeating a request with the same key returns the original result.
- Events are not replayed. Each carries `seq` and `stateVersion`; after a gap, refetch what you show. `events.subscribe` narrows which events a connection receives, with names or prefixes such as `chat.*`.
- Error codes are a fixed list in [src/errors.ts](https://github.com/devmello/psyche/blob/main/packages/protocol/src/errors.ts). Ones a client must handle include `not_paired`, `forbidden`, `approval_required` (with `details.approvalId`), `presence_required`, `rate_limited`, `unavailable` and `not_implemented`.

## Pairing and device keys

Every client and node is a paired device with its own Ed25519 key pair. The first frame on any connection must be `connect`:

1. The client sends `connect` with a protocol version range, its device id, public key, role (`client` or `node`), platform, device family and name.
2. The Gateway answers with a challenge: a random 32-byte nonce that expires after 60 seconds, the server origin and the negotiated version.
3. The client sends `connect.verify` with its signature over `psyche-connect-v1`, the nonce, platform, device family, protocol version and server origin, separated by newlines.
4. The Gateway answers `paired` (with the device's scopes), `pending` (with a short code to approve) or `denied`.

A new device stays pending until the owner approves it: from an admin device (Settings → Devices & nodes, or `psyche pairing approve <code>`), or on the machine with `psyched devices approve <code>`. Pending requests expire, and pairing attempts are rate limited per address.

There is no bearer token to steal. The device key is the credential, and every connection signs a fresh challenge. No token or key ever goes in a URL. Revoking a device ends its access, its node authority and the grants approved from it, permanently.

**Loopback auto-pairing.** The desktop app and the helper are paired without a prompt only when the connection is loopback, carries no `Origin` header, and presents the per-launch secret from `$PSYCHE_HOME/run/handshake.secret`. That path never grants `operator.admin`, because any process running as the same user can read the secret. On a fresh install the desktop app's main process makes itself the first admin once, through `devices.bootstrapAdmin`, which is refused as soon as any admin exists.

The exact wire details are in [docs/archive/plans/s00.md](https://github.com/devmello/psyche/blob/main/docs/archive/plans/s00.md), section "Wire spec v1", and [src/methods/connect.ts](https://github.com/devmello/psyche/blob/main/packages/protocol/src/methods/connect.ts).

## Scopes

The owner chooses a device's scopes when approving it; a client cannot declare its own. Every method names the one scope it needs.

| Scope | Allows | Methods |
| --- | --- | --- |
| `operator.read` | Reading threads, tasks, approvals, receipts, the audit log, settings, search | 79 |
| `operator.write` | Chatting, starting and steering tasks, editing memory, cosmetic settings, `nodes.invoke` | 63 |
| `operator.approvals` | Answering approval cards, passkey ceremonies | 5 |
| `operator.admin` | Devices and pairing, grant revocation, channel access, vault administration, skill installs, model keys and roles, backups, memory reset, audit export | 39 |
| `node` | `node.invoke`, `node.event` and `node.result`, for nodes only | 3 |
| none | `connect` and `connect.verify` | 2 |

`settings.set` is an `operator.write` method, but the Gateway also requires `operator.admin` for every key outside the cosmetic list; see [Settings reference](/reference/settings). Admin calls that widen access or destroy data, and security settings, also need fresh proof of presence (Touch ID or a passkey) once a verifier is registered. Such a call first fails with `approval_required` and a device-only card; retry with the `approvalId` after approving. See [Approvals and tiers](/security/approvals-and-tiers).

## Method families

Methods are defined in [src/methods/](https://github.com/devmello/psyche/tree/main/packages/protocol/src/methods), one file per family. Each definition carries its params and result schemas, its scope, whether it is side-effecting, and a description.

| Area | Families |
| --- | --- |
| Conversation | `threads.*`, `chat.*`, `questions.*`, `voice.*`, `speech.*`, `dictation.*` |
| Work | `tasks.*`, `automations.*`, `feed.*`, `ideas.*`, `goals.*` |
| Control | `approvals.*`, `grants.*`, `receipts.*`, `audit.*`, `settings.*` |
| Knowledge | `memory.*`, `library.*`, `files.*`, `documents.*`, `artifacts.*`, `search.*`, `skills.*` |
| Integrations | `connectors.*`, `mcp.*`, `channels.*`, `vault.*`, `models.*`, `browser.*`, `sandbox.*` |
| Devices | `connect`, `devices.*`, `passkeys.*`, `nodes.*`, `node.*` |
| Operations | `backup.*`, `logs.*`, `notifications.*`, `events.*` |
| Desktop only | `view.*` (pane control), `attention.*` |

A few rules hold across families. Nothing in the protocol lets a node or a tool change settings, grants or pairing. `approvals.answer` takes the single-use answer token delivered to that surface. Vault methods return item metadata, never values.

## Events

The Gateway pushes events for live updates, defined in [src/events.ts](https://github.com/devmello/psyche/blob/main/packages/protocol/src/events.ts). The main ones:

- `chat.delta`, `chat.block`, `chat.message`, `run.updated`, `tool_call.updated`: a turn streaming;
- `approval.created`, `approval.updated`, `receipt.created`: cards and their results;
- `task.updated`, `task.action`, `automation.*`: background work;
- `thread.updated`, `settings.changed`, `persona.updated`, `memory.file.changed`: state other clients should refresh;
- `device.updated`, `pairing.requested`, `node.updated`, `vault.locked`, `vault.unlocked`: devices and the vault;
- `notification.*`, `feed.*`, `idea.updated`, `goal.updated`, `question.*`, `view.command`, `gateway.shutdown`.

## Nodes

A node is any process that offers capabilities to the Gateway: Psyche Helper on a Mac, `psyche-node` inside the VM guest or on another machine. A node connects with role `node` and declares its capabilities. Each capability declares a side-effect class, like a tool, so the Permission Broker treats a click on a node like any other write.

- The Gateway calls a node with `node.invoke { invocationId, capability, params, approvalId? }`. The node accepts, streams `node.event` frames, and finishes with `node.result`, which may carry a receipt.
- Clients reach node capabilities through `nodes.invoke`, which goes through the broker and shows a card with the full arguments.
- Capabilities such as unlocking the vault or reading the Keychain are never reachable through `nodes.invoke` or a tool.

The node protocol is in [src/node.ts](https://github.com/devmello/psyche/blob/main/packages/protocol/src/node.ts). The desktop's browser bridge uses the same framing over its own socket; see [src/bridge.ts](https://github.com/devmello/psyche/blob/main/packages/protocol/src/bridge.ts).

## Versions and codegen

- The protocol version is 1. Clients send a version range in `connect`; the Gateway answers with the negotiated version or `protocol_version_mismatch`.
- Until v1.0, changes are additive only: new optional fields, new methods, new events. They are recorded in [CHANGES.md](https://github.com/devmello/psyche/blob/main/packages/protocol/CHANGES.md).
- Schemas are TypeBox values. `pnpm protocol:gen` writes JSON Schema, TypeScript declarations and Swift types into [generated/](https://github.com/devmello/psyche/tree/main/packages/protocol/generated). `generated/schema.json` lists every method and event under `x-psyche`, which is the easiest starting point for a client in another language.

## Learn more

- [packages/protocol/README.md](https://github.com/devmello/psyche/blob/main/packages/protocol/README.md)
- [docs/02 §7, nodes](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md#7-nodes-and-the-node-protocol) and [§11, API and protocol](https://github.com/devmello/psyche/blob/main/docs/02-architecture.md#11-api-and-protocol)
- [docs/05 §10, control plane and remote access](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#10-control-plane-and-remote-access)
- [Settings reference](/reference/settings)
- [CLI reference](/reference/cli)
- [Architecture](/contributing/architecture)
