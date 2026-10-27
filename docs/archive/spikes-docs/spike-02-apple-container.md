# Spike 02: Linux sandbox backends on macOS (Apple `container` vs Colima vs Docker)

Date: 2026-10-19. Time box: one day. Prototype: `spikes/sandbox-backends/` (throwaway). Raw results: `spikes/sandbox-backends/results/`. Hand-off target: S21 (`packages/sandbox`).

## Answer

| host | default backend | fallback | egress for `network: proxy` |
|---|---|---|---|
| **macOS 26 / 27** (measured on 27.0.1) | **Apple `container`** (1.5.0, VM per container) | an existing Docker context (OrbStack / Docker Desktop / Colima) if the user configures it | `--network none` + `--publish-socket` bridge to the host proxy (no IP path to the host) |
| **macOS 15** | **Colima `--vm-type vz`** (MIT, Homebrew), but use an existing OrbStack or Docker Desktop context when one is detected | none: report "no sandbox backend" (never the host shell) | `--internal` Docker network + relay sidecar to the host proxy |
| Linux | Docker / Podman (unchanged from ADR-008) | | as Docker |

What the per-task contract costs:

- **Apple `container`**: ~0.6 s from `run` to the first command finishing in a fresh container (each one boots its own VM), ~55 ms per later command, ~240 MB of host memory per live container that is **not given back** after the guest frees it. Two flag gaps (no `--pids-limit`, no `no-new-privileges`) are closed with `--ulimit nproc` and an image with no setuid bits; named volumes need a one-time root `chown`.
- **Docker (OrbStack)**: ~0.13 s to a fresh container, ~35 ms per command, a shared VM that gives memory back. Every contract flag exists natively. Isolation between tasks is Linux namespaces in one shared VM, not a VM per task.

Both backends pass every contract check (below). Colima and Docker Desktop were **not measured**: they are not installed here, and installing Colima was declined for this spike. The Docker-flag contract is engine-level, so the OrbStack contract results should carry over to Colima, but S21 must measure Colima's VM boot and file sharing before it ships as the macOS 15 default.

## Setup

- Host: MacBook with Apple M5, 16 GB, macOS 27.0.1 (26A434). Host Rosetta for macOS apps is not installed (macOS 27 does not restore it on upgrade).
- Apple `container` 1.5.0 (`brew install container`; bottle is 431 MB on disk). Kernel: kata 6.18.35 installed by `container system start --enable-kernel-install`.
- Docker 29.4.0 engine on OrbStack 2.2.3 (already installed; the Docker CLI context was `orbstack`).
- Measurement conditions: other Psyche sessions shared this Mac. The `measure.sh` runs (01:27–01:31) agreed with each other within ~10–25% (Apple warm start 656 → 617 ms, OrbStack 168 → 126 ms across two runs). The final contract re-runs (01:55–02:05) ran at a load average of 37–51 on 10 cores, and per-command times there went up 3–5× (OrbStack 20-command mean 369 ms; a bare `docker run --rm true` took 2.6–20 s at that point). Pass/fail results don't depend on load; S21 should repeat the timings on an idle machine.
- Image `psyche-sandbox:spike` (`spikes/sandbox-backends/Dockerfile`): `node:24-trixie-slim` plus bash, python3, git, jq, ripgrep, curl and procps; UID/GID 1000; every setuid/setgid bit removed; 562 MB uncompressed (the node base dominates; see failure modes).

## Comparison

Medians of n runs (min / p90 in the result files). "First command done" means `run -d` followed by `exec true` returning.

| metric | Apple `container` | Docker on OrbStack | Colima (vz) |
|---|---|---|---|
| isolation unit | one lightweight VM per container | containers in one shared VM | containers in one shared VM |
| cold: backend start (cached kernel/image) | 249 ms (`container system start`) | 487 ms (`orb start`) | not measured |
| cold: backend start + first container + first command | 910 ms | 928 ms | not measured |
| warm: new container, first command done | **617 ms** (n 10) | **126 ms** (n 10) | not measured |
| warm: one-shot `run --rm true` | 609 ms | 156 ms | not measured |
| stop with `--init` | 55 ms | 46 ms | |
| stop **without** `--init` (`sleep` as PID 1 ignores SIGTERM) | ~5–6 s (default grace 5 s) | ~10 s (grace 10 s) | |
| restart stopped container + first command | 481 ms | 93 ms | |
| command round trip (`exec true`) | 53 ms (n 20) | 34 ms (n 20) | |
| round trip through the runner wrapper (`timeout` + `bash -c`) | 58 ms | 37 ms | |
| 20 bounded commands, sequential | 1.4–1.6 s total (mean 68–78 ms) | 1.4 s total (mean 69 ms) | |
| 200 MB host → volume, `cp` CLI | **fails silently** (exit 0, no file) | 421 MB/s | |
| 200 MB host → volume, `exec -i` stdin stream | 367 MB/s | 746 MB/s | |
| 200 MB host → container, read-only bind mount | 719 MB/s (virtiofs) | 408 MB/s | |
| 200 MB container → host, rw bind mount | 976 MB/s | 1143 MB/s | |
| 200 MB copy inside the workspace volume | 1290 MB/s (ext4 block device) | 5000 MB/s | |
| host owner of a file UID 1000 writes to a bind mount | the host user | the host user | |
| memory: idle sandbox | 242 MB footprint per container VM | VM RSS 300–550 MB shared by all containers; +~1 MB cgroup per idle container | |
| memory: holding 400 MB | 641 MB | 699 MB | |
| memory: 20 s after freeing 400 MB | **641 MB (not returned)** | 183–302 MB (returned) | |
| memory: host services | 25 MB (apiserver, images, vmnet, runtime) | in the VM figure | |
| per-volume size cap | yes (`volume create -s 2G`, ext4 image) | no | no |
| amd64 images | yes, `--platform linux/amd64` (~1.8× slower than arm64 on a shell loop) | yes | yes (`--vz-rosetta`) |
| license | Apache-2.0 | proprietary (free for personal use) | MIT (Lima Apache-2.0) |
| macOS support | 26+ only | 13+ | 13+ for `vz` |

Memory notes: Apple's figure is the `phys_footprint` of the `com.apple.Virtualization.VirtualMachine` process that appears for the container. OrbStack's guest RAM shows up in the RSS of `OrbStack Helper`, not in its footprint, and moves around a lot right after a VM boot (1240 MB right after `orb start`, 553 MB a minute later), so treat the OrbStack row as a range. The Apple behaviour matches the technical overview's warning about partial ballooning: freed guest memory is not returned to the host until the container stops.

## Contract checks

`contract.sh` runs the architecture §9 contract on a long-lived per-task container: network none, read-only rootfs, all capabilities dropped, 512 MB / 1 CPU / 128 pids, 64 MB `/tmp`, persistent `/workspace` volume.

| check | Apple (`none`) | Apple (`socket` profile) | Docker / OrbStack |
|---|---|---|---|
| runs as UID 1000, CapEff 0, no setuid binaries | pass | pass | pass |
| 20 bounded commands, all exit 0 | pass | pass | pass |
| 1 MiB of stdout arrives intact | pass | pass | pass |
| `sleep 30` with a 3 s bound ends with 124 at ~3.07 s | pass | pass | pass |
| interrupt via a process-group kill from a second `exec` | pass (68–90 ms) | pass | pass (101 ms) |
| files survive stop/start (5 MB, sha256 compared) | pass | pass | pass |
| network: only `lo`; curl to a name or an IP fails; DNS fails | pass | pass | pass |
| writes to `/etc`, `/usr/local/bin`, `/`, `/var`, `/home`, `/opt` fail | pass | pass | pass |
| `/tmp` stops at 64 MB | pass | pass | pass |
| 700 MB allocation is OOM-killed (137) | pass | pass | pass |
| pids capped (of 200 background `sleep`s) | 75–87 start (`--ulimit nproc`) | pass | 117 start (`--pids-limit`) |
| CPU: `cpu.max` 100000/100000 | yes; `nproc` 2 (1 vCPU + 1 "cpuOverhead") | same | yes; `nproc` 10 |

Behaviour that S21 has to design around (found by these checks):

1. **Killing the host-side `exec` client never stops the command.** On Apple, `container exec` ignores SIGTERM and keeps blocking; on SIGKILL the client dies and the process keeps running. On Docker, the client exits on either signal and the process keeps running. The runner must start every command in its own session (`setsid -w bash -c 'echo $$ > /tmp/cmd-<id>.pid; …'`) and interrupt it with `kill -TERM -- -<pgid>` (then KILL) from a second `exec`, then record the receipt as `uncertain`.
2. **Timeouts are enforced inside the container** with coreutils `timeout -k 2 <s>`, and a host watchdog sits a few seconds later in case the exec channel itself hangs.
3. **`container cp` into a mounted volume silently does nothing** (exit 0, no file; it seems to write to the rootfs underneath the mount, and does nothing at all when the rootfs is read-only). Use `exec -i … 'cat > file'` (or tar over stdin) for imports on every backend, and verify the size.
4. **Apple named volumes come up `root:root`.** Docker copies the image's `/workspace` ownership into a new volume; Apple does not. Initialise each new volume once with `container run --rm --network none --uid 0 -v <vol>:/workspace <image> chown 1000:1000 /workspace`.
5. **Use `--init` on both backends.** Without it, `sleep infinity` as PID 1 ignores SIGTERM, so every stop waits out the grace period (5 s on Apple, 10 s on Docker).
6. Apple defaults are 4 CPUs / 1 GB per container when no flags are given (`container system property list`), so always pass `--cpus` / `--memory`.

## Exact flags

Apple `container` (macOS 26+), per-task container, network none:

```bash
container volume create -s 2G psyche-ws-<thread>
container run --rm --progress none --network none --uid 0 --gid 0 \
  -v psyche-ws-<thread>:/workspace psyche-sandbox chown 1000:1000 /workspace
container run -d --name psyche-task-<id> --progress none --init \
  --network none --read-only --cap-drop ALL --uid 1000 --gid 1000 \
  --memory 512M --cpus 1 --ulimit nproc=128:128 --tmpfs /tmp:size=64m \
  -v psyche-ws-<thread>:/workspace -w /workspace psyche-sandbox sleep infinity
container exec psyche-task-<id> setsid -w timeout -k 2 60 bash -c '<command>'
container rm -f psyche-task-<id>
```

Apple, `network: proxy` (socket profile, used by `egress-test.sh apple socket`): replace `--read-only` with read-only system paths, because a published socket only works on the container's own rootfs (it fails on a tmpfs and on a volume):

```bash
container run -d … --network none --cap-drop ALL --uid 1000 --gid 1000 \
  --memory 512M --cpus 1 --ulimit nproc=128:128 --tmpfs /tmp:size=64m \
  --read-only-path /usr --read-only-path /etc --read-only-path /bin --read-only-path /sbin \
  --read-only-path /lib --read-only-path /opt --read-only-path /var --read-only-path /home \
  --read-only-path /root --read-only-path /srv --read-only-path /mnt --read-only-path /media \
  --publish-socket /tmp/psyche-<short-id>.sock:/run/psyche/egress.sock \
  -e HTTPS_PROXY=http://127.0.0.1:3128 -e HTTP_PROXY=http://127.0.0.1:3128 \
  -e ALL_PROXY=socks5h://127.0.0.1:1080 …
```

`--read-only-path` is marked experimental in 1.5.0. `/` stays writable only by root, so UID 1000 can still write only `/run/psyche` (the image creates it with owner 1000), `/tmp` and `/workspace`; the contract check passes with this profile.

Docker (OrbStack, Docker Desktop, Colima, Linux):

```bash
docker volume create psyche-ws-<thread>
docker run -d --name psyche-task-<id> --init \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  -v psyche-ws-<thread>:/workspace -w /workspace psyche-sandbox sleep infinity
docker exec psyche-task-<id> setsid -w timeout -k 2 60 bash -c '<command>'
```

Colima: `colima start --vm-type vz --vz-rosetta --cpus 2 --memory 2` and `DOCKER_CONTEXT=colima` (OpenMuse's profile is `--cpus 2 --memory 3 --disk 12 --vm-type vz`).

## Opt-in egress (`network: proxy`)

`egress/proxy.py` is a host-side HTTP proxy (CONNECT and absolute-form) plus a SOCKS5 proxy (CONNECT only), modelled on `srt`'s design. It enforces an allowlist (exact names and `*.suffix`; IP literals only by exact entry) and a port allowlist (80, 443), resolves DNS itself, denies the request if any resolved address is not globally routable, connects to the address it checked (so DNS rebinding cannot swap in a private address), and logs every decision as a JSON line. The sandbox gets `HTTP(S)_PROXY` / `ALL_PROXY` and no DNS.

How the sandbox reaches it, per backend:

| path | how | result |
|---|---|---|
| Apple, `--network <internal>` | `container network create --internal`; proxy binds to the host side of that vmnet (`192.168.128.1`); sandbox runs `--no-dns` | contract passes, but **any host service bound to 0.0.0.0 is reachable** on the gateway IP (a decoy `http.server` returned 200) |
| **Apple, socket bridge** (recommended) | `--network none` + `--publish-socket`; `egress/socket-bridge.py` shim in the sandbox listens on 127.0.0.1:3128/1080, and the host dialer keeps a pool of idle connections into the published socket and splices each to the proxy on 127.0.0.1 | all checks pass; the sandbox has no IP route anywhere (the decoy was unreachable) |
| Docker, `--internal` network | the internal network cannot reach the host at all, so a relay sidecar (`egress/relay.py`, our image, read-only, caps dropped) on internal + bridge forwards to `host.docker.internal:3128` → proxy on 127.0.0.1 | all checks pass; the decoy was unreachable; Docker's embedded DNS did not resolve external names |

Checks that passed on all three paths (`results/egress-*.md`): allowlisted HTTPS through the HTTP proxy and through SOCKS5 (`socks5h`); `npm view left-pad` (registry.npmjs.org); `git ls-remote https://github.com/octocat/Hello-World`; denied: a host not in the allowlist (403 / SOCKS reply 2), plain HTTP to one, `169.254.169.254`, `127.0.0.1.nip.io` (allowlisted by `*.nip.io` but resolves to loopback), a disallowed port (`pypi.org:22`); direct connections without the proxy fail; no DNS in the sandbox.

Notes for the real implementation:

- On Apple, the host end of an `--internal` network's bridge exists only while a container is attached, so a proxy bound to it has to start after the first container, and it is reachable by every container on that network. The socket bridge avoids both problems and needs a short host socket path (macOS caps Unix socket paths at 104 bytes; `container` refuses a longer `--publish-socket` path at start).
- Start order of the dialer and the shim does not matter: a dialer started 3 s before the shim retried until the shim listened, and the next requests returned 200.
- The shim runs as UID 1000 inside the sandbox, so the agent can kill it; that only cuts off its own egress, because the policy is enforced on the host.
- SOCKS5 is CONNECT only (no UDP ASSOCIATE), so QUIC/HTTP3 and raw DNS stay blocked, as intended.

## Failure modes and first-run costs

| what | measured |
|---|---|
| Apple `container` install | `brew install container`: 431 MB bottle; `brew services` does **not** install a kernel |
| first `container system start` | 98 s (downloads the kata kernel, ~6.18); prompts for kernel install unless `--enable-kernel-install` / `--disable-kernel-install` is passed |
| `container system start` afterwards | ~250 ms; the apiserver is a launch agent and must be running before any `container` command (the CLI warns "CLI plugins not available" otherwise) |
| first `container build` | 112 s (pulls `container-builder-shim` and boots a 2 CPU / 2 GB BuildKit VM that keeps running); later builds 8–70 s |
| first `docker build` on OrbStack | 31 s, including the base-image pull |
| image size | 562 MB uncompressed with the node base image; ship a slimmer image or pre-pull it during onboarding so the first task does not pay for it |
| VM boot | on Apple every new container is a VM boot (~0.6 s here); there is no warm pool, so keep one container per task alive across its commands rather than one per command |
| memory | Apple container VMs keep freed guest memory until they stop; cap concurrent sandboxes (2–3 on a 16 GB Mac) and remove containers when tasks end |
| Rosetta | amd64 images ran on both backends with no host Rosetta installed (`--platform linux/amd64`; Apple's `--rosetta` flag made no difference here). macOS 27 drops Intel macOS apps in macOS 28; build the sandbox image arm64-first and don't depend on amd64 |
| shell scripts | macOS `/bin/bash` is 3.2 (no `EPOCHREALTIME`, no associative arrays); there is no `timeout` binary on the host |
| `container stop` | default grace is 5 s; without `--init` every stop waits it out |

## Proposed amendments to ADR-008

1. **Backends**: keep "Apple `container` on macOS 26+", and make the macOS 15 order explicit: an existing OrbStack or Docker Desktop context if detected, otherwise Colima `--vm-type vz` offered by the installer. Detection order on macOS 26+: `container system status` running → configured Docker context → typed "no backend" error.
2. **Contract wording**: "128 pids" is `--pids-limit` on Docker and `--ulimit nproc=128` on Apple; "no added privileges" is `no-new-privileges` on Docker and "no setuid/setgid binaries in the image + empty bounding set" on Apple. Add `--init` to the contract.
3. **Network proxy mode on Apple**: use `--network none` + `--publish-socket` with the reverse-pool bridge, not an `--internal` network, because an internal network exposes every 0.0.0.0 host service to the sandbox. This needs the "read-only system paths" profile instead of `--read-only`.
4. **Consequences**: add the per-container memory cost on Apple (~240 MB, not returned while running) and the concurrency cap it implies; the ~100 s first-run kernel download and the builder VM; the fact that `container cp` cannot be used for workspace imports.

## Hand-off to S21

- Reuse `lib.sh`'s flag sets and `contract.sh`'s checks as the starting point for the OpenMuse-style smoke test; the interrupt (process-group kill) and import (`exec -i`) patterns are the ones that worked.
- `egress/proxy.py` is the reference behaviour for the `network: proxy` interface (policy, DNS handling, log fields); a production version needs per-task allowlists, a lifetime bound and receipts for allowed connections.
- Still to measure: Colima on macOS 15 (VM boot, virtiofs throughput, `host.lima.internal` reaching a proxy on 127.0.0.1, which was not verified), Docker Desktop, and Podman; symlink traversal, PTY mode and concurrency limits (out of scope here).
- Clean-up on this Mac: the `buildkit` container keeps running (`container builder stop`); `container system stop` stops everything.
