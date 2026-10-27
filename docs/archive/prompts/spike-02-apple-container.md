# Spike 02 — Linux sandbox backends on macOS: Apple `container` vs Colima vs Docker

Time box: one day. You are a Psyche engineer (read `README.md`) running a throwaway prototype in `spikes/sandbox-backends/` with a write-up in `docs/spikes/spike-02-apple-container.md`. Branch `spike/02-apple-container`. Do not touch any package.

## Read first
`prompts/_shared-rules.md`; `docs/02-architecture.md` §9; `docs/07-tech-decisions.md` ADR-008; `research_notes/Psyche personal agent landscape/macos_vm_and_integration.md` KQ2; `opendots_openclaw_harnesses.md` KQ1 §1h (OpenMuse's container contract and smoke test).

## Question to answer
Which backend should the `SandboxRunner` use on this Mac (macOS 27) and on macOS 15, and what does the per-task contract cost in startup time and complexity?

## Build
1. A tiny nonroot image (UID 1000, read-only rootfs, bash/python/node/git/jq/ripgrep) built once.
2. For each available backend (Apple `container`, Colima with `--vm-type vz`, Docker Desktop if installed), a script that: starts a container with network none, caps (512 MB, 1 CPU, 128 pids, 64 MB tmp), a persistent `/workspace` volume; runs 20 bounded commands sequentially; interrupts a long-running command; writes and reads files across a container restart; attempts to reach the network (must fail); attempts to write outside `/workspace` (must fail).
3. Measure cold start, warm start, command round trip, file-share throughput for a 200 MB copy, and memory overhead.
4. Prototype the opt-in egress path: a host-side HTTP/SOCKS proxy with a domain allowlist (model it on Anthropic's `sandbox-runtime` design) and confirm the container can reach only allowlisted hosts when network is enabled through the proxy.

## Report
A comparison table, the recommended default per macOS version, the exact backend commands/flags to use, failure modes (image pull time, VM boot, Rosetta), and amendments to ADR-008 if any. Hand the findings to S21 via the write-up.
