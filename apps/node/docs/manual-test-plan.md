# psyche-node manual test plan: vsock inside a VM

CI cannot boot a VM, so the vsock path is verified by hand. Record results (date, host/guest macOS or distro versions, pass/fail, notes) in `docs/status/s19.md`.

## Prerequisites

- A host running the Gateway (`psyched`) and a forwarder from vsock port 7980 to the Gateway's node socket. Until the VM manager (S14) ships one, on a Linux host with a Linux guest: `socat VSOCK-LISTEN:7980,fork UNIX-CONNECT:$HOME/.psyche/run/node.sock`.
- A guest with this repo (or the installer share) and `pnpm install` done.
- Linux guest: `socat` with vsock support (`socat -V | grep -i vsock`). macOS guest: a bridge command, given as `PSYCHE_NODE_VSOCK_BRIDGE='["/path/bridge","{cid}","{port}"]'`.

## 1. Guest detection

1. In the guest: `pnpm --filter @psyche/node start -- manifest --vsock 2:7980`.
2. Expect the `transports` log line to list `vsock:2:7980` first and `isGuest: true`.
3. On the host (not a guest), the same command lists vsock last. **Pass** if both hold.

## 2. Pairing over vsock

1. Guest: `pnpm --filter @psyche/node start -- run --vsock 2:7980`.
2. Expect `waiting for the owner to approve this node` with a code; `psyched devices list` on the host shows the pending request with transport `unix` (forwarded).
3. Host: `psyched devices approve <code>` with scope `node`.
4. Expect the guest to log `paired` with `transport: vsock:2:7980` within a few seconds, and `nodes.list` to show the node `online`, kind `vm-guest`.

## 3. Invoke over vsock

1. From a paired operator client: `nodes.invoke {nodeId, capability: "health", params: {}}`. Expect `ok: true`, `clockOffsetMs` near 0.
2. With a sandbox backend in the guest: `nodes.invoke … "exec" {argv: ["uname", "-a"]}`. Expect stdout from the guest's sandbox and a receipt of kind `exec`.
3. With an `fs.roots` entry in `node.json`: `fs.read` a file inside the root succeeds; `fs.read` of `/etc/passwd` fails `forbidden` / `outside_roots`.

## 4. Reconnection and resume

1. Stop the host forwarder for 30 s, then start it. Expect the guest to log `gateway unreachable` with growing `retryInMs` (capped at 30 s) and then `paired` again with no new pairing request.
2. Suspend the VM for two minutes and resume. Expect a reconnect and a fresh `clockOffsetMs`; a `fs.write` receipt's `createdAt` matches the host clock within a second.
3. Restart `psyched` on the host. Expect the guest to reconnect without re-pairing.

## 5. Fallback

1. Kill the bridge binary path (`PSYCHE_NODE_VSOCK_BRIDGE='["/nonexistent"]'`) and pass `--gateway ws://<host-nat-ip>:7979/ws` with a Gateway bound for it. Expect `paired` over WS and a log line naming the vsock failure.

## 6. Helper proxy in a macOS guest

1. Run `scripts/guest-bootstrap.sh --repo <repo> --helper-app "<path>/Psyche Helper.app"`.
2. Expect `<home>/run/node.sock` and `<home>/run/handshake.secret` (both 0600), the helper connected (`health` → `providers.helper.helper: "connected"`), and the node re-declaring with `computer.*` capabilities.
3. `nodes.invoke … "computer.screenshot" {}` returns an image of the guest display; `vault.unlock` and `permissions.request` are absent from `nodes.capabilities`.
