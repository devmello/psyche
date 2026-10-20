# @psyche/sandbox

## 0.3.0-alpha.0

### Minor Changes

- dc49b2a: Container `SandboxRunner` for Apple `container`, Docker and Podman: per-scope nonroot containers with no network, bounded commands with receipts, a workspace file API, an in-container PTY and `pnpm sandbox:smoke`.
- 1955b55: Dev servers an `exec` leaves listening in a sandbox are forwarded to a host `127.0.0.1` port the runner owns and announced (`onDevServer`: host port, container port, root pid) for the browser's dev preview (I12). The Gateway's new sandbox part maps them onto the dev-preview registry.
- f5e8f54: Egress proxy (K4): `EgressProxy` with per-scope allowlists, DNS pinning, SSRF ranges refused, TLS-only CONNECT with SNI checks, broker `new_origin` decisions (cards in tainted tasks), receipts and per-connection logs. Proxy-mode sandboxes keep network `none` and reach it through an in-container shim over stdio, on Apple `container`, Docker and Podman. `createSandboxEgress` is the Gateway hook.
- a50c115: `ContainerSandboxRunner.openStdio(sandboxId, { argv, cwd, env })`: a long-lived sandboxed process with raw stdin / stdout / stderr pipes for stdio MCP servers (#143). Env is delivered inside the container, the process keeps the container busy, `kill` and runner shutdown stop its process group, and its output is untrusted.
- 38f71de: Taint hand-offs from S02's loop-grants work: `Task.taintSources` is persisted in SQLite (design-08, #96), and the sandbox keeps file-level provenance on workspace files and exec results (`ExecRequest.provenance` / `taintSources`, `ExecResult.provenance`; design-07, #97).
- 355246e: The container runner bind-mounts validated host folders (`ensureSandbox(scope, {mounts})`, V10 coding workspaces); the Gateway protects `$PSYCHE_HOME` from mounts and exposes the sandbox part's egress context tracker.

### Patch Changes

- a020ca4: Egress proxy hardening: plain HTTP forwards exactly one request with `Host` forced to the URL's host (#282); origin decisions expire so `once` approvals and revoked grants are re-asked, allowlisting a refused host works, and IPv6 is classified from parsed bytes with every IPv4-embedding form covered (#283).
- 70207bd: Exec secrets never become arguments: env reaches the command through a pipe and an in-container trampoline, not `env -- NAME=value` (#289). An exec given a vault secret is reaped as it returns, so no background child keeps the value (#290). `reapBackground: "always"` reaps every exec, for one-shot work such as document conversion (#286).
- ee80eea: Fixes the #314 regression: execs with env lost their output on real containers (`setsid: wait: …`) because the wrapper's fd-3 process substitution left a child that `setsid --wait` reaped instead of its own. The trampoline now reads the pairs from stdin, which the wrapper never reads, and the wrapper leaves no child.
- 4b3f571: VM mode, Gateway side (L1–L5): a Task can name its workspace (`sandbox | vm`), `SandboxBackendKind` gains `vm`, and `VM_SETTING_KEYS` / `VmSettings` type the owner's VM-mode settings.
- Updated dependencies [428ec1e]
- Updated dependencies [a5cef4e]
- Updated dependencies [4f8dff6]
- Updated dependencies [353afa9]
- Updated dependencies [2558bfe]
- Updated dependencies [7ac975c]
- Updated dependencies [09c0c6f]
- Updated dependencies [d982437]
- Updated dependencies [c4175a2]
- Updated dependencies [493b4a5]
- Updated dependencies [eaf91c6]
- Updated dependencies [19c1ba5]
- Updated dependencies [4f74993]
- Updated dependencies [5e605af]
- Updated dependencies [8a8dacb]
- Updated dependencies [6665567]
- Updated dependencies [310ac67]
- Updated dependencies [2f63bac]
- Updated dependencies [dc190a6]
- Updated dependencies [5d2cbeb]
- Updated dependencies [0899f3b]
- Updated dependencies [08664c3]
- Updated dependencies [e54d672]
- Updated dependencies [3461262]
- Updated dependencies [8a9ee2c]
- Updated dependencies [f80b0ec]
- Updated dependencies [75a0f80]
- Updated dependencies [2e9c025]
- Updated dependencies [e4c109b]
- Updated dependencies [5dcf208]
- Updated dependencies [c840e75]
- Updated dependencies [2607fc3]
- Updated dependencies [4bc7113]
- Updated dependencies [515b904]
- Updated dependencies [f4cf9c0]
- Updated dependencies [e0d2f7e]
- Updated dependencies [95f1980]
- Updated dependencies [2b2e906]
- Updated dependencies [13afc8a]
- Updated dependencies [1331bfc]
- Updated dependencies [04be9ec]
- Updated dependencies [2525712]
- Updated dependencies [e7c3564]
- Updated dependencies [a549b95]
- Updated dependencies [75d2aa9]
- Updated dependencies [420ab8e]
- Updated dependencies [206f295]
- Updated dependencies [e99009a]
- Updated dependencies [38f71de]
- Updated dependencies [952c222]
- Updated dependencies [ee4c781]
- Updated dependencies [0c71158]
- Updated dependencies [4b3f571]
  - @psyche/protocol@0.3.0-alpha.0
