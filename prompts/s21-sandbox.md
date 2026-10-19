# Session S21 — Sandbox container image and SandboxRunner

You are building Psyche, an open-source self-hosted personal AI agent (read `README.md`). You are session **S21 — Sandbox**: implement `packages/sandbox` (the `SandboxRunner` contract) and the container image under `deploy/sandbox-image/`. Work in your own worktree on branch `ws/s21-sandbox`. You own `packages/sandbox/**`, `deploy/sandbox-image/**` and `docs/status/s21.md`. Start after the S00 bootstrap PR has merged (it creates the contract you implement).

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §9 (sandbox subsystem) and §4.3 (tool side-effect metadata)
3. `docs/05-security-and-permissions.md` §5 (sandbox and execution)
4. `docs/03-feature-spec.md` rows K1–K5, K7, K8
5. `docs/07-tech-decisions.md` ADR-008
6. `packages/protocol/src/contracts/SandboxRunner.ts` and the fake in `packages/testing`
7. `docs/spikes/spike-02-apple-container.md` if it exists (backend measurements)
8. `research_notes/Psyche personal agent landscape/opendots_openclaw_harnesses.md` KQ1 §1h (OpenMuse's container contract and smoke test) and `macos_vm_and_integration.md` KQ2 (Apple `container`, Colima, Docker, Podman facts)

## Build
- **Image** (`deploy/sandbox-image/Dockerfile`, multi-arch arm64/amd64): Debian or Ubuntu LTS base, nonroot user UID/GID 1000, bash, Python 3 + uv, Node 24, git, ripgrep, jq, pandoc, poppler-utils, pdftk-java, ffmpeg; a `full` variant adding LibreOffice; read-only root filesystem compatible (`/tmp` and `/workspace` writable only); no shell for root; image signed/digest-pinned in a `versions.json`.
- **`SandboxRunner` implementation** with backends `apple-container` (macOS 26+ `container` CLI), `docker` (Docker Desktop / Colima / Docker on Linux) and `podman`; backend auto-detection with an explicit config override; **never** a host-shell fallback (if no backend, return a typed error).
- **Contract**: per-task container with `network: none` by default; `network: proxy` option that sets `HTTP(S)_PROXY` to a host-side proxy URL supplied by the caller (the proxy itself is out of scope; document the interface); caps 512 MB RAM (no swap), 1 CPU, 128 pids, 64 MB tmp, all capabilities dropped, `no-new-privileges`, read-only rootfs; a persistent `/workspace` volume per scope id; bounded commands (default 60 s, configurable; 2 s kill grace) with receipts `{argv, cwd, exitCode, durationMs, stdout, stderr (each capped at 64 KB), filesChanged, outcome: ok|failed|uncertain|timeout}`; interrupted commands → `uncertain`; concurrency limit per scope; container reuse (warm) with idle teardown; an interactive PTY mode (`openPty`) streaming via an async iterator for the terminal pane.
- **File API** confined to `/workspace`: list, read (256 KB cap), write (atomic), edit (replace), import/export files (10 MB cap), symlink and special-file rejection.
- **CLI for manual testing**: `pnpm sandbox:smoke`.

## Tests (must pass in CI on Linux with Docker; on macOS skip backends that are missing with a clear message)
Port OpenMuse's smoke test: image builds; commands run as UID 1000; writes to `/usr` fail; network is unreachable (`curl` to an IP fails fast); output caps enforced; a long `sleep` is interrupted and recorded as `uncertain`; files persist across container restart; symlink traversal rejected; PDF import/export preserves bytes; PTY mode echoes; concurrency limit holds; backend detection order.

## Definition of done
`pnpm -w typecheck && pnpm -w lint && pnpm --filter @psyche/sandbox test` green; README documenting backends, flags and the egress-proxy interface; `docs/status/s21.md` with measured cold/warm start times per backend on your machine.
