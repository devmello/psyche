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
// r: { exitCode, stdout, stderr, durationMs, truncated, filesChanged, timedOut, outcome }

await runner.files.writeText(sbx.id, "notes.md", "hello\n");
await runner.files.edit(sbx.id, "notes.md", { oldText: "hello", newText: "hi" });
const pdf = await runner.files.exportFile(sbx.id, "out/report.pdf");

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
| `files` | `list`, `stat`, `readText` / `writeText` (256 KB), `edit` (exact replace), `importFile` / `exportFile` (10 MB, byte-exact). |
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
| `maxPtys` | 4 | Per scope; more rejects with `rate_limited`. |
| `maxRunningSandboxes` | 3 on Apple, 8 elsewhere | Across scopes; the least recently used idle container is stopped first. |
| `idleTimeoutMs` | 10 min | An idle container is stopped (warm reuse until then). 0 disables. |
| `egressProxy` | none | See "Egress proxy interface". |
| `namePrefix` | `psyche` | Container `<prefix>-sbx-<hash>`, volume `<prefix>-ws-<hash>`; the hash is over the scope. |
| `appleVolumeSize` | `8G` | Apple volumes are fixed-size ext4 images. |

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
- **Env travels over stdin** as NUL-separated pairs, so vault-injected `PSYCHE_SECRET_*` values never appear in host `ps` output. Container-level env (proxy URLs) is passed as `-e NAME`, with the value inherited from the CLI's own environment.
- Timeouts are enforced twice: by `timeout` in the container (TERM, then KILL after 2 s), and by a host watchdog 7 s later in case the exec channel hangs.
- **Interrupts** (an aborted `signal`) kill the process group from a second exec, because killing the host `exec` client does not stop the process (spike 02). The sequence is TERM, then KILL after 2 s, then the client itself.
- Results follow the contract. A timed-out command has `timedOut: true`, `exitCode: null` and `outcome: "uncertain"`. An interrupted one has `exitCode: null` and `outcome: "uncertain"`. Interrupted commands are never replayed. stdout and stderr are each capped at 128 KB (`EXEC_OUTPUT_CAP_BYTES`, architecture §9), with `truncated` set when either cap is hit.
- `filesChanged` lists workspace files with a ctime newer than the start of the command (created, written or chmod-ed; deletions are not listed). `/workspace/.cache` is skipped and the list is capped at 1,000 entries.

## File API

Everything runs inside the container as UID 1000 (a fixed Python helper), so the file API sees exactly what commands see. Each path component is opened from a `/workspace` fd with `O_NOFOLLOW`, so a symlink anywhere in the path is rejected with `forbidden`. Leaves must be regular files, so FIFOs, sockets and devices are rejected too. `..` and absolute paths outside `/workspace` are rejected on the host first. Writes are atomic: a temp file in the same directory, then fsync, rename and fsync of the directory. Caps: 256 KB for text, 10 MB for import and export. Imports stream over `exec -i` stdin, because `container cp` silently does nothing on Apple (spike 02).

## PTY

`openPty` allocates the pseudo-terminal **inside** the container with a Python relay, so the host needs neither node-pty nor a TTY. Input, resize and env are framed over stdin (`[type u8][len u32 BE][payload]`); output is the raw terminal stream. `close()` hangs up, then kills the process group after 2 s. Who may type into a PTY is the caller's decision: an agent PTY needs a session-scoped approval (security §5.4).

## Egress proxy interface (`network: "proxy"`)

The proxy itself is not in this package (security §5.2; spike 02's `egress/proxy.py` is the reference). Its owner passes:

```ts
egressProxy: {
  network: "psyche-egress",          // a backend network with no internet route
  url: (scope) => "http://10.89.0.2:3128", // the proxy as seen from inside the container
  noProxy: "",                        // optional
}
```

The runner attaches the container to `network` and sets `HTTP_PROXY`, `HTTPS_PROXY` and their lowercase forms, plus `NO_PROXY`. The proxy owner must make `network` unable to reach anything except the proxy. On Docker that means `docker network create --internal` plus a relay sidecar (Docker's internal networks cannot reach the host). If `network: "proxy"` is requested without this config, it rejects with `unavailable`. There is no fallback to a bridged network.

**Apple `container`:** proxy mode currently rejects with `unavailable`. An `--internal` vmnet exposes every host service bound to 0.0.0.0 (spike 02). The safe design is `--network none` plus `--publish-socket` and an in-sandbox shim, which needs the "read-only system paths" profile and is a follow-up.

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

The smoke test is the OpenMuse one plus PTY and concurrency checks (`src/smoke.ts`): nonroot, read-only system files, no network, capped output, timeout and interrupt recorded as `uncertain` with no processes left, `filesChanged`, text edit, symlink and FIFO rejection, PDF byte round trip, persistence across a restart, PTY echo and resize, and the concurrency limit. `pnpm test` runs the same checks on every detected backend (`test/integration.test.ts`), plus the protocol conformance suite. Set `PSYCHE_SANDBOX_TESTS=0` to skip them, or `PSYCHE_SANDBOX_TEST_BACKENDS=docker` to restrict them. When no backend is present they are skipped with a message.

## Not implemented / stubbed

- Proxy mode on Apple `container` (socket bridge), as explained above.
- `srt` wrapper for host-side helpers (K5) and `exec_host` (K7) are other sessions' work.
- Image publishing and signing: `deploy/sandbox-image/publish.sh` is written but has not been run, so `versions.json` digests are `null`.
- Podman has not been run on a real host (it was not installed on the dev machine); its flags are Docker's.
- `strictInlineEval` (security §5.1) applies to allowlist decisions in the Permission Broker, not to this runner, which runs what it is given inside the container.
