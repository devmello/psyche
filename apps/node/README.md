# @psyche/node — `psyche-node`

**Owner:** S19 (`docs/archive/prompts/s19-node-agent.md`). Features: L3 (guest install), N13 (node side), K6/K7 (exec on a node).

The headless node agent that runs inside the macOS guest VM (topology B) or on a remote Mac or Linux box (topology C). It pairs with a Gateway as a `node` device and offers exec, file system, browser and, through a co-located Psyche Helper, computer use as node capabilities (architecture §3.1, §7, §10).

## Running

```sh
pnpm --filter @psyche/node start -- run --gateway ws://127.0.0.1:7979/ws
pnpm --filter @psyche/node start -- manifest     # print what this machine would offer
pnpm --filter @psyche/node start -- identity     # device id and public key
```

On first connect the Gateway answers `pending` and the node logs a pairing code; the owner approves it with `psyched devices approve <code>` (or in the UI) and chooses the scopes. The Gateway then closes the pending connection and the node reconnects paired. Only the mac helper and the desktop can auto-pair; a node never can (security §10).

Installers: `scripts/install-macos.sh` (LaunchAgent `com.psyche.node`), `scripts/install-linux.sh` (systemd user unit), `scripts/guest-bootstrap.sh` (what the VM manager runs inside a fresh macOS guest). Manual test plan for vsock inside a VM: [docs/manual-test-plan.md](docs/manual-test-plan.md).

## State and configuration

`<home>` is `$PSYCHE_NODE_HOME`, else `$PSYCHE_HOME/node`, else `~/.psyche/node` (mode 0700). It holds `identity.json` (Ed25519 key and device id, 0600; a looser mode is refused), `node.json` (configuration), `run/` (the helper socket and its per-launch secret) and `browser/profiles/`.

`node.json` (every field optional):

```json
{
  "name": "Studio Mac guest",
  "gateway": { "url": "ws://127.0.0.1:7979/ws", "socket": "/path/node.sock", "vsock": { "cid": 2, "port": 7980, "bridge": ["socat", "-", "VSOCK-CONNECT:{cid}:{port}"] } },
  "fs": { "roots": [{ "path": "/Users/me/Shared", "mode": "ro" }] },
  "exec": { "sandbox": true, "host": { "enabled": false, "cwdRoots": [] } },
  "browser": { "enabled": "auto" },
  "helper": { "enabled": "auto" }
}
```

Flags and environment (`--gateway`/`PSYCHE_NODE_GATEWAY`, `--socket`/`PSYCHE_NODE_GATEWAY_SOCKET`, `--vsock CID:PORT`/`PSYCHE_NODE_VSOCK`, `PSYCHE_NODE_VSOCK_BRIDGE`, `--name`/`PSYCHE_NODE_NAME`, `--home`) override the endpoint and name only. File-system roots and host exec can be turned on only in `node.json`, by the machine's owner.

## Transports

| Transport | When | Framing |
| --- | --- | --- |
| vsock | VM guest (`/dev/vsock` on Linux, `kern.hv_vmm_present` on macOS) with a vsock endpoint; preferred | NDJSON through a bridge process (Node has no `AF_VSOCK`) |
| Unix socket | `--socket`, or a Gateway's `$PSYCHE_HOME/run/node.sock` on this machine | NDJSON |
| WebSocket | `--gateway`, default `ws://127.0.0.1:7979/ws` (loopback, tailnet, SSH tunnel) | one frame per message, no `Origin`, no token in the URL |

Each reconnect tries the plans in that order. Backoff is exponential with jitter (0.5 s → 30 s) and resets after 10 s paired. `denied` with `device revoked`, a key or role mismatch, or a protocol mismatch stops the node (exit 78, which the systemd unit does not restart).

## Capabilities

| Capability | Side effect | Offered when |
| --- | --- | --- |
| `health` | none | always |
| `exec` | write, `command`, streaming | a sandbox backend (Apple `container`, Docker, Podman) is present; never falls back to the host. Inside the sandbox Mac, `"exec": {"guest": {"enabled": true, "root": "…"}}` in `node.json` runs it on the guest itself instead (VM mode, L1–L5): no shell, one directory per scope under `root` mapped to `/workspace`, an explicit env |
| `exec.host` | destructive, `command`, streaming | `exec.host.enabled` in `node.json`; every call needs an `approvalId` and a cwd inside `cwdRoots` (K7) |
| `fs.list`, `fs.stat`, `fs.read` / `fs.write`, `fs.mkdir` / `fs.remove` | read / write / destructive, `path` | `fs.roots` configured; absolute paths only, `realpath`-confined, `ro` roots refuse writes, symlink escapes refused |
| `browser.*` (sessions, tabs, navigate, snapshot, find, read_text, screenshot, click, type, select, scroll, wait) | none / read / write | a Chromium is found (`PSYCHE_CHROMIUM_PATH` or a standard location) or `browser.enabled: true`; persistent profiles under `<home>/browser/profiles` |
| `computer.*`, `apps.*`, `notify.*`, `speech.*`, `keychain.set|delete|status` | as the helper declares them | Psyche Helper is connected to the node's socket (launch it with `PSYCHE_HOME=<home>`) |

Side-effecting calls return a protocol `Receipt` (kind, outcome, summary, the invocation id and the approval id), stamped with the Gateway-aligned clock: `paired.serverTime` gives the skew, so a guest that resumed with a stale clock still writes correct receipt times. Receipts never contain file contents, command output, typed text or env values.

The Gateway runs every `nodes.invoke` through the Permission Broker first; the node passes `approvalId` through untouched (to the helper as well) and additionally refuses `exec.host` without one. `vault.*`, `permissions.*` and the secret-returning keychain calls are never proxied (security §10, §13). `node.cancel {invocationId}` (not yet in protocol v1; the helper honours it too) aborts a running invocation. When the helper connects or leaves, the node re-declares its manifest by reconnecting, once in-flight work drains.

## Public API

`NodeAgent`, `createNodeRuntime`, `parseArgs`, `loadOrCreateIdentity` / `generateIdentity`, `planTransports` / `channelFactory`, `detectVmGuest`, `SkewClock`, `Backoff`, `createInvocationContext` and the `CapabilityProvider` types (`src/index.ts`). Providers live in `src/capabilities/`.

## Stubbed or not done

- vsock needs a bridge: `socat` on Linux guests; macOS guests need a bridge command until Psyche Helper offers one. The host side (forwarding the vsock port to the Gateway's node socket) belongs to the VM manager (S14).
- No credential fill on the node: the vault and fills stay on the Gateway.
- `exec` has no live output stream (the `SandboxRunner` contract returns output at the end); `exec.host` streams stdout and stderr.
- Release packaging: the installers run the source with `tsx`, like `psyched`, until S22 ships a bundled binary.

## Tests

`pnpm --filter @psyche/node test`: a fake Gateway that verifies the real Ed25519 handshake (pairing paired / pending / denied, capability negotiation, invoke streaming, approval-id passthrough, cancel, clock skew, reconnection, re-declaration), transports over real WS, Unix sockets and a simulated vsock bridge, fs root confinement, sandbox and host exec receipts, the helper hub against a TypeScript stand-in for the Swift helper, and browser calls against `FakeBrowserDriver`.
