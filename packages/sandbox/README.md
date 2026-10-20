# @psyche/sandbox

**Owner:** S21 (`prompts/s21-sandbox.md`). Features K1–K3 and K8 (base) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

This package implements the `SandboxRunner` contract (`packages/protocol/src/contracts/SandboxRunner.ts`) with real containers. Each thread, project or task scope gets a nonroot container with no network and a persistent `/workspace` volume. Commands are bounded and return receipts. There is also a workspace file API and an interactive PTY. **There is never a host-shell fallback.** With no container backend, `ensureSandbox` rejects with `unavailable`.

The image is in [`deploy/sandbox-image/`](../../deploy/sandbox-image/README.md).

## Public API

```ts
import { createSandboxRunner } from "@psyche/sandbox";

const runner = createSandboxRunner(); // detects the backend
const sbx = await runner.ensureSandbox({ kind: "thread", id: threadId }); // network "none"
const r = await runner.exec({ sandboxId: sbx.id, argv: ["python3", "-c", "print(1)"], cwd: "/workspace", timeoutMs: 60_000 });
// r: { exitCode, stdout, stderr, durationMs, truncated, filesChanged, timedOut, outcome, provenance }

// Every write carries the calling turn's provenance (design-07); absent means untrusted.
await runner.files.writeText(sbx.id, "notes.md", "hello\n", { provenance: ctx.taint ? "untrusted" : "trusted", sources: ctx.taintSources });
await runner.files.edit(sbx.id, "notes.md", { oldText: "hello", newText: "hi" }, { provenance: "trusted" });
const { text, provenance, sources } = await runner.files.readText(sbx.id, "notes.md");
const { bytes } = await runner.files.exportFile(sbx.id, "out/report.pdf");

const pty = await runner.openPty(sbx.id, { cols: 120, rows: 40 });
for await (const chunk of pty.output) term.write(chunk); // pty.write(), pty.resize(), pty.close()
```

| member | what it does |
|---|---|
| `backends()` | Available backends, in preference order. Empty means every call fails. |
| `ensureSandbox(scope, {network})` | Idempotent per scope. It adopts a matching container left by an earlier process and restarts a stopped one. A different `network` for a live scope rejects with `conflict`. |
| `exec(request)` | Runs a bounded command (contract semantics, below). |
| `stop(id)` / `destroy(id)` | Stop the container (it restarts on next use), or remove it. The volume stays in both cases. |
| `deleteWorkspace(scope)` | Removes the container **and** the workspace volume. |
| `files` | `list`, `stat`, `readText` / `writeText` (256 KB), `edit` (exact replace), `importFile` / `exportFile` (10 MB, byte-exact). Writes take `{ provenance, sources }`; reads, stats and listings return the file's provenance (see "File provenance"). |
| `openStdio(id, { argv, cwd, env })` | A long-lived process with raw stdin / stdout / stderr pipes (no PTY, no CRLF translation), for stdio MCP servers (#143). Same user, network and no-fallback rules as `exec`; env goes to an in-container relay on stdin (a length-prefixed header), never into argv or the CLI's environment. Keeps the container busy until it exits, at most `maxStdioProcesses` (8) per scope. `kill()` signals the process group (TERM, then KILL); `destroy`, `deleteWorkspace` and `dispose` TERM every group first. `provenance` is `untrusted` and the scope's workspace counts as untrusted from then on. `receipt()` after exit names env keys, never values. |
| `openPty(id, opts)` | Interactive terminal; `output` is an async iterator of raw bytes, and `transcript()` keeps the last 128 KB. |
| `dispose({remove})` | Stops (or removes) every container this runner started. |
| `receiptOf(request, result)` | The receipt shape for Activity and the audit log. It never includes env. |

### Options (`ContainerSandboxRunnerOptions`)

| option | default | |
|---|---|---|
| `backend` | detected | `apple-container`, `docker` or `podman`; also read from `PSYCHE_SANDBOX_BACKEND`. An override restricts detection to that one backend and never falls back to another. |
| `cliPaths` | from `PATH` plus the usual install dirs | Per-backend CLI path. |
| `image` | see below | Image reference; also read from `PSYCHE_SANDBOX_IMAGE`. |
| `variant` | `base` | `core`, `base` or `full`. |
| `limits` | 512 MB, 1 CPU, 128 pids, 64 MB `/tmp` | Per-container caps. |
| `maxTimeoutMs` | 30 min | Largest accepted `timeoutMs`. |
| `maxConcurrentExecs` | 4 | Per scope; extra calls queue, and an aborted waiter rejects with `cancelled`. |
| `maxStdioProcesses` | 8 | Per scope; more `openStdio` rejects with `rate_limited`. |
| `maxPtys` | 4 | Per scope; more rejects with `rate_limited`. |
| `maxRunningSandboxes` | 3 on Apple, 8 elsewhere | Across scopes; the least recently used idle container is stopped first. |
| `idleTimeoutMs` | 10 min | An idle container is stopped (warm reuse until then). 0 disables. |
| `egressTunnel` | none | The egress proxy for `network: "proxy"` (K4); see "Egress proxy". |
| `egressProxy` | none | An external proxy on a backend network (Docker / Podman only); superseded by `egressTunnel`. |
| `namePrefix` | `psyche` | Container `<prefix>-sbx-<hash>`, volume `<prefix>-ws-<hash>`; the hash is over the scope. |
| `appleVolumeSize` | `8G` | Apple volumes are fixed-size ext4 images. |
| `onDevServer` | unset | Dev-server forwarding (I12): `started` / `stopped` events for servers an exec leaves listening; see "Dev servers". Unset means no probe and no forward. |
| `devServers` | re-probe at 0.5, 1, 2, 4, 8 s; poll 5 s; 32 connections | Timing and the per-server connection cap for dev-server forwarding. |
| `provenanceStore` | in memory | Where each scope's file provenance index lives. `new FileProvenanceStore(dir)` keeps it across restarts (one JSON file per scope under `dir`, for example `$PSYCHE_HOME/sandbox/provenance`). |

## Backends

Detection order (ADR-008, confirmed by [spike 02](../../docs/spikes/spike-02-apple-container.md)):

1. **Apple `container`**, on macOS 26+ on Apple silicon when the `container` CLI is installed. If its system service is stopped, `ensureSandbox` starts it (`container system start --disable-kernel-install`). The kernel must already be installed: run `container system start` once interactively.
2. **Docker**: Docker Desktop, OrbStack, Colima (`colima start --vm-type vz`) or Docker on Linux. Used when `docker version` reaches a daemon. Colima uses the `colima` Docker context.
3. **Podman**: used when `podman info` reaches the service (a `podman machine` on macOS).

On Linux the order is Docker, then Podman.

The contract flags per backend (`src/backends.ts`; unit-tested in `test/backends.test.ts`):

| contract | Docker / Podman | Apple `container` |
|---|---|---|
| UID/GID 1000 | `--user 1000:1000` | `--uid 1000 --gid 1000` |
| read-only rootfs | `--read-only` | `--read-only` |
| no capabilities | `--cap-drop ALL` | `--cap-drop ALL` |
| no new privileges | `--security-opt no-new-privileges` | no flag exists; the image has no setuid/setgid binaries (`harden.sh`) |
| 512 MB, no swap | `--memory 512m --memory-swap 512m` | `--memory 512M` (VM, no swap) |
| 1 CPU | `--cpus 1` | `--cpus 1` |
| 128 pids | `--pids-limit 128` | `--ulimit nproc=128:128` (only UID 1000 runs in the VM) |
| 64 MB tmp | `--tmpfs /tmp:rw,nosuid,nodev,size=64m` | `--tmpfs /tmp:size=64m` |
| network none | `--network none` | `--network none` |
| workspace | named volume (Docker copies the image's ownership into it) | `volume create -s 8G`, then a one-shot root `chown` (the volume root comes up root:root) |
| fast stop | `--init` | `--init` |

The runner only ever runs the fixed CLI with argument arrays (`shell: false`). There are no host bind mounts.

## Exec semantics

- `argv` is passed to the container as separate arguments and is never a shell string. The runner runs a fixed in-container wrapper (`src/scripts.ts`). The wrapper puts the command in its own session with a pid file and runs it under `timeout --kill-after=2 <s>`, with stdin set to `/dev/null`.
- **Env travels over stdin** as NUL-separated pairs, so vault-injected `PSYCHE_SECRET_*` values never appear in host `ps` output. It is applied only to the command itself (`env -- NAME=value… argv`), never to the wrapper shell, so a name such as `PATH` or `secs` cannot change how the wrapper behaves. This is also why `argv[0]` may not contain `=`. Container-level env (proxy URLs) is passed as `-e NAME`, with the value inherited from the CLI's own environment.
- **Helpers never use PATH.** The image PATH puts `/workspace/.local/bin` first, which the agent can write. So every helper and every tool inside the helpers is started by absolute path (`/usr/bin/bash`, `/usr/bin/python3`, `/usr/bin/timeout`, …), and Python runs with `-I -S`. Helper output (`filesChanged`, directory listings) is validated on the host as untrusted data. The smoke test plants fake binaries to check this.
- Timeouts are enforced twice: by `timeout` in the container (TERM, then KILL after 2 s), and by a host watchdog 7 s later in case the exec channel hangs.
- **Interrupts** (an aborted `signal`) kill the process group from a second exec, because killing the host `exec` client does not stop the process (spike 02). The sequence is TERM, then KILL after 2 s, then the client itself.
- Results follow the contract. A timed-out command has `timedOut: true`, `exitCode: null` and `outcome: "uncertain"`. An interrupted one has `exitCode: null` and `outcome: "uncertain"`. Interrupted commands are never replayed. stdout and stderr are each capped at 128 KB (`EXEC_OUTPUT_CAP_BYTES`, architecture §9), with `truncated` set when either cap is hit.
- `filesChanged` lists workspace files with a ctime newer than the start of the command (created, written or chmod-ed; deletions are not listed). The start marker is back-dated 50 ms because ctime uses the coarse kernel clock. `/workspace/.cache` is skipped and the list is capped at 1,000 entries. Execs that run at the same time in one scope see each other's changes, and the walk covers the whole workspace, so a very large tree (for example `node_modules`) slows every exec.

## File API

Everything runs inside the container as UID 1000 (a fixed Python helper), so the file API sees exactly what commands see. Each path component is opened from a `/workspace` fd with `O_NOFOLLOW`, so a symlink anywhere in the path is rejected with `forbidden`. Leaves must be regular files, so FIFOs, sockets and devices are rejected too. `..` and absolute paths outside `/workspace` are rejected on the host first. Writes are atomic: a temp file in the same directory, then fsync, rename and fsync of the directory. Caps: 256 KB for text, 10 MB for import and export. Imports stream over `exec -i` stdin, because `container cp` silently does nothing on Apple (spike 02).

### File provenance (S23 design-07)

Taint is turn-scoped, so an injected payload only has to land in a workspace file in turn N to be read back as the agent's own text in turn N+1. The runner therefore keeps a **host-side** provenance index per scope (never in the volume: everything under `/workspace` is writable by the agent as UID 1000, so a sidecar there could be edited away by the same payload):

- Every write through the file API records the caller's `{ provenance, sources }` with the sha256 of the bytes (`edit` records no hash). **Absent means `untrusted`**: pass `"trusted"` only from an untainted turn (or for the owner's own file), and pass the turn's `taintSources` with an untrusted write. `importFile` is for downloads and attachments, which are untrusted at birth.
- `exec` records its `filesChanged` with the request's `provenance` / `taintSources` (again absent means `untrusted`). The result's `provenance` is `untrusted` when the request was, or whenever the workspace already holds an untrusted file, because the command may have copied it; files such a command changes inherit the untrusted files' sources. The `exec` tool should report `result.provenance` as the `ToolResult` provenance so the loop taints the turn. When the change listing is capped (1,000 entries) or fails after an untrusted command, the workspace counts as untrusted until `deleteWorkspace`.
- `readText`, `exportFile` and `stat` return the latest recorded write's `provenance` and `sources`. A file with no record (written through a PTY, present before tracking, or after a restart without a persistent store) or whose bytes no longer match the recorded hash is `untrusted` with `{ sourceKind: "workspace", origin: "/workspace/<path>" }`: nobody vouches for it. `list` marks each file and returns `provenance: "untrusted"` for a listing that holds any untrusted file, symlink or special file. Names are data from inside the sandbox either way.
- `deleteWorkspace` clears the index with the volume. There is no "mark trusted" call yet; the owner re-approving a file is a follow-up for the files pane.

## Dev servers (feature I12)

The browser's dev preview opens a loopback server only if Psyche started it (security §3.10). A sandbox has network `none`, so a server on port 5173 **inside** it is not the host's `localhost:5173`; announcing that number would let the preview open whatever host process holds it. With `onDevServer` set, the runner instead:

- **Probes the exec's own session** right after it returns (`LISTENERS`, reading `/proc/net/tcp{,6}` and the session's fds inside the container). Only sockets in `LISTEN` owned by a process of that exec's session count, so a server another exec or a PTY started is not attributed to it. If the command left processes running but nothing listens yet (`npm run dev &`), it re-probes in the background at 0.5, 1, 2, 4 and 8 s.
- **Forwards each listener** to a `127.0.0.1:<ephemeral>` port it binds on the host and relays every connection into the container over `exec -i` (`PORT_RELAY`, connecting to loopback there). The container keeps network `none`; the forward is inbound from host loopback only, and adds no egress.
- **Reports** `started` with the host port, the container port, the root pid (the exec's session leader inside the container), the listener's pid, the exec's cwd and argv. A poll every 5 s reports `stopped` (`exited`) when the listener is gone; stopping, removing or disposing the container reports `stopped` (`sandbox`) for all of them. A forwarded server keeps its container from the idle stop.

Each forwarded connection is one `exec -i` (about 60 ms on Docker); browsers reuse connections, so a preview pays it a few times. Servers a PTY starts, servers that call `setsid` themselves, and listeners bound to a non-loopback address are not forwarded. The node agent does not set `onDevServer`: a node's loopback is not the Gateway's.

## PTY

`openPty` allocates the pseudo-terminal **inside** the container with a Python relay, so the host needs neither node-pty nor a TTY. Input, resize and env are framed over stdin (`[type u8][len u32 BE][payload]`); output is the raw terminal stream. `close()` hangs up, then kills the process group after 2 s. Who may type into a PTY is the caller's decision: an agent PTY needs a session-scoped approval (security §5.4).

## Egress proxy (`network: "proxy"`, feature K4)

Security §5.2: a sandbox that opts into network gets a host-side, domain-allowlisted proxy and nothing else. This package ships it (`src/egress/`).

**How traffic leaves the container.** With `egressTunnel` set (normally `createSandboxEgress(...).egressTunnel`), a proxy-mode sandbox still runs with network **`none`**. A shim (`EGRESS_SHIM`, Python `-I -S`, UID 1000) listens on the container's own `127.0.0.1:3128`, which `HTTP_PROXY` / `HTTPS_PROXY` point to. It multiplexes every connection over one long-lived `exec -i` stdio stream to the host, where `EgressProxy` serves it with the sandbox's scope. There is no container network, no sidecar and no host port, so this works the same on Apple `container`, Docker and Podman. Docker's `--internal` networks cannot reach the host, and an Apple vmnet would expose host services (spike 02). The runner starts the shim with the container, waits for it to be ready, restarts it with the container, and stops it on stop and remove.

**What the proxy enforces** (`EgressProxy`):

- **Deny by default.** A scope reaches only hosts on its allowlist (`setAllowlist(scope, entries)`). Entries look like `pypi.org`, `*.githubusercontent.com` (subdomains only, never the apex or a bare TLD), `registry.example.com:8443`, or `mirror.lan private`. Ports 80 and 443 apply unless one is named.
- **Two request forms only.** It accepts `CONNECT host:port`, which must carry TLS whose ClientHello server name equals the CONNECT host, so there is no plaintext tunnel and no domain fronting. It also accepts absolute-form `http://` requests. Each is forwarded in origin-form as exactly one request, with `Host` forced to the URL's host, `Connection: close` and no proxy headers. A client `Host` naming another virtual host on a shared CDN is replaced, and pipelined requests after the first are dropped (#282). `Transfer-Encoding` bodies, conflicting `Content-Length` values and folded headers are refused with 400. There is no TLS interception.
- **DNS by the proxy.** It resolves names itself, checks every address, and connects to the checked one, so a rebind cannot swap it. Loopback, link-local, cloud metadata (`169.254.169.254`, `fd00:ec2::254`), multicast, reserved and documentation ranges are always refused. IPv6 is classified from its parsed bytes, so uncompressed forms count the same. Mapped, translated, compatible, NAT64 and 6to4 forms are classified by the IPv4 address they embed, and local-use NAT64 and Teredo are refused (#283). Private and CGNAT ranges need an entry marked `private`.
- **One decision per origin per scope at a time** through the Permission Broker. A decision is reused for 60 s (`verdictTtlMs`), then the broker is asked again, so a `once` approval covers one burst and a revoked grant stops applying (#283). Refusing a host as not allowlisted is not cached as a decision, so allowlisting it later works. The broker call is: `decide` as a `new_origin` read, with the task's context and `newTarget: true`. In a tainted task the broker asks, and the card names the taint sources. If the broker is set and the context is unknown, the scope counts as tainted. A connection waits up to 20 s for the card, then gets `approval-pending`. The answer then decides every later connection to that origin, and there is never a second card.
- **Receipts and logs.** Each first decision per origin gets a receipt (`sandbox.egress`, `ok` or `failed`), whether allowed, denied or not allowlisted. Every connection is logged with host, address, byte counts and duration through `onLog` or the hook's `logger`. Blocked requests get `403` with `X-Proxy-Error`, using the codes `blocked-by-allowlist`, `blocked-address`, `approval-pending`, `approval-denied`, `denied-by-policy`, `dns-failure` and `upstream-unreachable`.

**Composition** (Gateway, S01):

```ts
const egress = createSandboxEgress({ broker, context: (scope) => contextForScope(scope), logger });
composeSandbox(services, { runner: { egressTunnel: egress.egressTunnel } });
containerLauncher({ sandbox: runner, egressAllowlist: egress.egressAllowlist }); // MCP servers
egress.egressAllowlist({ kind: "task", id: taskId }, task.egressHosts);       // a task's declared hosts
```

The older `egressProxy: { network, url, noProxy }` option still attaches the container to an external proxy's internal network on Docker and Podman. `egressTunnel` takes precedence.

Not covered: throughput is a Python select loop, so it is fine for `pip install` or `git clone` and not meant for bulk transfer. There is no per-connection backpressure from the host back into the shim. Plain-HTTP keep-alive is not supported.

## Bind mounts (V10 coding workspaces)

`ensureSandbox(scope, { mounts: [{ source, target, readOnly }] })` bind-mounts host folders under `/workspace` (`--mount type=bind,…[,readonly]` on every backend). `validateMounts` refuses a source that is not its own real path, `/`, the home folder or any ancestor of it, `~/Library` and `protectedMountRoots` (the Gateway passes `$PSYCHE_HOME`), and any target outside `/workspace/`; the caller checks the owner's folder grant. Mounts are fixed per scope (part of the config label; asking for other mounts is a `conflict`). The coding helper mounts a repository read-write at `/workspace/repo` with its `.git` read-only on top. Only the fake driver has run this; a real-backend check belongs in the CI smoke test.

## Image selection

In order: the `image` option, `PSYCHE_SANDBOX_IMAGE`, the digest-pinned published reference in `deploy/sandbox-image/versions.json`, and finally the local tag `psyche-sandbox:<variant>-dev`. No image is published yet, so today it is always the local tag. A missing local image rejects with `unavailable` and a hint to build it.

## Manual testing

From `packages/sandbox`:

```bash
pnpm sandbox:smoke                         # detected backend, core image (must exist)
pnpm sandbox:smoke --backend docker --build
pnpm sandbox:smoke --backend apple-container --variant base --build
pnpm sandbox:build --backend docker --variant base
```

The smoke test is the OpenMuse one plus PATH-hijack, PTY and concurrency checks (`src/smoke.ts`, 15 checks): nonroot, read-only system files, no network, capped output, timeout and interrupt recorded as `uncertain` with no processes left, `filesChanged`, text edit, symlink and FIFO rejection, PDF byte round trip, persistence across a restart, PTY echo and resize, and the concurrency limit. `pnpm test` runs the same checks on every detected backend (`test/integration.test.ts`), plus the protocol conformance suite. Set `PSYCHE_SANDBOX_TESTS=0` to skip them, or `PSYCHE_SANDBOX_TEST_BACKENDS=docker` to restrict them. When no backend is present they are skipped with a message.

## Not implemented / stubbed

- Egress: no per-connection backpressure from host to shim; plain-HTTP keep-alive is not supported (one request per connection).
- `srt` wrapper for host-side helpers (K5) and `exec_host` (K7) are other sessions' work.
- Image publishing and signing: the release workflow runs `deploy/sandbox-image/publish.sh` on `v*` tags and opens a PR with the digests, but no tag has run it yet, so `versions.json` digests are `null`.
- Podman has not been run on a real host (it was not installed on the dev machine); its flags are Docker's.
- Dev servers: only those an `exec` starts in its own session; PTY-started servers are not detected.
- File provenance: no xattr on the files themselves (the index is host-side only), no owner "mark trusted" path, and PTY writes are unobserved (they read back as untrusted, which is the safe answer).
- `strictInlineEval` (security §5.1) applies to allowlist decisions in the Permission Broker, not to this runner, which runs what it is given inside the container.
