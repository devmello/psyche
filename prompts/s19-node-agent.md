# Session S19 — Node agent (psyche-node)

You are building Psyche (read `README.md`). You are session **S19 — Node agent**: `apps/node`, the headless process that runs inside the macOS guest VM or on remote machines and offers exec, filesystem, browser and (via a co-located Mac helper) computer-use capabilities to a Gateway through the node protocol. Start this session only after S01 (Gateway), S08 (browser) and S21 (sandbox) have merged. Work in your own worktree on branch `ws/s19-node-agent`. You own `apps/node/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §3.1, §3.2 (topologies B and C), §7 (node protocol), §10 (VM mode)
3. `docs/05-security-and-permissions.md` §10 (pairing, tokens), §13 (VM mode)
4. `docs/03-feature-spec.md` rows L3, N13 (node side), K6/K7 (exec on a node)
5. Protocol node schemas; `packages/browser`, `packages/sandbox`, `packages/vault` fill helpers
6. Research: `opendots_openclaw_harnesses.md` KQ2 §2h (OpenClaw nodes and companions), `macos_vm_and_integration.md` KQ1 (vsock, VirtioFS, Lume's in-guest daemon)

## Mission
- A single binary (`psyche-node`) that pairs with a Gateway (device identity, signed challenge, scoped `node` token), advertises capabilities from what is available on the machine (sandbox backend present? Playwright browser installed? Mac helper socket present?), and serves `node.invoke` with streaming events and receipts.
- Capabilities: `exec` (through `packages/sandbox` when available; host exec only if the Gateway's policy explicitly allows and the user enabled it on this node), `fs.*` over granted roots, `browser.*` via the Playwright driver with persistent profiles on the node, `computer.*`/`apps.*`/`notify.*`/`speech.*`/`keychain.*` proxied to a co-located Mac helper, `health`.
- Transports: WS over loopback/tailnet/SSH tunnel; vsock when running as a VM guest (detect and prefer); reconnection with backoff; clock skew tolerance for approvals.
- Installer scripts for a macOS guest (LaunchAgent) and Linux (systemd), plus the guest-side bootstrap the VM manager (S14, L3) calls.

## Definition of done
- Tests with a fake Gateway: pairing, capability negotiation, invoke streaming, approval-id passthrough, exec receipts, fs root confinement, reconnection; a manual test plan for vsock inside a VM.
- README and `docs/status/s19.md`.
