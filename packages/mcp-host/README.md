# @psyche/mcp-host

**Owner:** S09 (`prompts/s09-mcp-connectors.md`). Features M1, M2, M3 (container launcher; `.mcpb` later) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md).

How Psyche talks to MCP servers safely: the `McpHost` implementation on the MCP TypeScript SDK v2 (`@modelcontextprotocol/client` 2.3.1).

## Public API

- `createMcpHost(options)` / `new PsycheMcpHost(options)` implements `McpHost` (`packages/protocol/src/contracts/McpHost.ts`), plus:
  - `connect(serverId)` (reconnect), `describe(serverId)` (era, error, raw tools, warnings, stderr tail), `pinnedTools(serverId)`, `requiresUserInteraction(serverId, tool)`;
  - `appResources(serverId)` and `readAppResource(serverId, uri)` for MCP Apps;
  - `close()`.
- `registerMcpServerTools(host, registry, serverId)` registers a server's tools into the agent-core `ToolRegistry` as `mcp__<server>__<tool>`; `sync()` re-registers after a change.
- `srtLauncher({ srtPath, settingsDir, psycheHome })`, `directLauncher()` (bundled only), `containerLauncher({ sandbox, egressAllowlist? })` (M3), `StdioLauncher` (`prepare`: the host spawns the command; `open`: the launcher starts the process and returns a transport), `PipeTransport`, `mcpSandboxScope`.
- `PsycheOAuthProvider`, `MemoryTokenStore`, `McpTokenStore`, `clientMetadataDocument(url)`, `startLoopbackReceiver()`.
- Helpers: `toolsListHash`, `diffTools`, `sideEffectFor`, `provenanceFor`, `inspectTool`, `mcpToolName` / `parseMcpToolName`, `resolveEnv`, `mcpCredentialTarget`, `strictCanonicalJSON`.

`McpHostOptions`: `bundledServerIds`, `launcher`, `bundledLauncher`, `secrets` (`{ credentials: CredentialBroker, approve() }`), `oauth` (`{ clientMetadataUrl, tokenStore, openAuthorizationUrl, timeoutMs }`), `inputRequester`, `requestTimeoutMs`, `maxResultBytes`, `fetch`, `onEvent`.

Events (`onEvent`): `tools_changed` (previous / new hash, per-tool diff, poisoning warnings), `status`, `auth_required`.

## How it maps to the docs

| Rule (docs) | Where |
| --- | --- |
| Spec 2026-07-28 with 2025-11-25 fallback (architecture §4.9, ADR-010) | `Client` with `versionNegotiation: { mode: "auto" }`: `server/discover` probe, per-request `_meta`, MRTR; legacy `initialize` when the probe says so. `describe().era` reports `modern` / `legacy`. |
| No Roots / Sampling / Logging / DCR | No such capabilities are declared; elicitation only with an `inputRequester`. The provider has no `saveClientInformation`, so the SDK cannot register a client; it always offers the pre-registered id or the CIMD URL, and requests to a discovered `registration_endpoint` are blocked as well. |
| MRTR | SDK auto-fulfilment through the `elicitation/create` handler → `inputRequester` (message tagged `untrusted`); at most 4 rounds. |
| OAuth 2.1 with CIMD identity | `PsycheOAuthProvider`: `client_id` = `clientMetadataUrl` (publish `clientMetadataDocument()` there), PKCE S256, `state` verified by a `127.0.0.1` loopback receiver, RFC 9207 `iss` checked by the SDK, tokens in an injected `McpTokenStore` keyed by server id plus resource URL. After connect the provider is disarmed: a refresh failure mid-call fails `unauthorized` (reconnect to sign in again) instead of opening a browser nobody listens for. Pre-registered client ids (Slack-style) via `auth: { kind: "oauth", clientId }`. |
| Trust tiers; `bundled` only for allowlisted ids (security §11) | `addServer` rejects `trust: "bundled"` unless the id is in `bundledServerIds`. |
| `tools/list` hashing, rug-pull revocation (M2) | `toolsListHash` covers name, title, description, schemas, annotations, icons, execution, `_meta` of the raw listing; sorted by name; no Unicode normalization. `listTools` always refetches (an older, slower reply never re-pins over a newer one); a different hash emits `tools_changed`; `callTool` with any other hash fails `conflict`. Tools whose names collide after sanitizing (`a.b` / `a_b`), duplicates and names over 64 characters are not callable (`invalid_name` warnings). |
| Annotations are hints, actionable only for `bundled` | `sideEffectFor`: bundled honors `readOnlyHint` / `destructiveHint`; others are at least `write`, raised to `destructive` by the hint. |
| Results from non-bundled servers are `untrusted` | `provenanceFor`; result size capped (256 KiB default). JSON-RPC errors are returned as `isError` results with the server's provenance, never as `PsycheError` text; connect errors in `describe()` carry `errorProvenance: "untrusted"`. |
| Tool poisoning probe (security §7.2) | `inspectTool` warnings: instruction-like text, hidden markup, credential paths, cross-server references, invisible characters, oversized descriptions. Warnings never relax policy. |
| Secrets from the vault as env at spawn, never in config | `resolveEnv`: `{{cred:slug}}` in env values only, each resolved with an approval through `CredentialBroker.resolve` (target `account: mcp:<id>`); placeholders in argv, cwd or URLs are rejected; names that steer the launcher, loader, shell, TLS trust or proxies (`PATH`, `HOME`, `NODE_*`, `DYLD_*`, `LD_*`, `SRT_*`, `BASH_ENV`, `*_PROXY`, …) cannot be set (case-insensitive). |
| stdio under `srt` (security §5.3; M3 partly) | `srtLauncher` (absolute `srtPath` only) writes a 0600 settings file per launch: deny-read Psyche home, `~/.ssh`, `~/Library/Keychains`, cloud / git / npm / docker credentials, browser profiles; writes only to a per-launch scratch dir (also `TMPDIR` and default cwd); network only through srt's proxies with the server's allowlist; `allowLocalBinding`, `allowAppleEvents`, `enableWeakerNetworkIsolation` and weaker nested sandboxes pinned off. Runs `srt --settings <file> -- <argv>`. Without a sandboxing launcher a non-bundled stdio server is refused; there is no bare fallback. |
| stdio in the sandbox container (security §5.1, §11; M3) | `containerLauncher({ sandbox })` starts each server in its own sandbox scope (`{ kind: "task", id: "mcp:<serverId>" }`: own container and `/workspace` volume) through the runner's `ensureSandbox` + `openStdio` (#143) and speaks MCP over the process pipes (`PipeTransport`, 16 MB message cap). No host path is visible: `allowWrite` and a host `cwd` are refused, the default cwd is `/workspace`. Only the server's own env reaches it; vault values go to the runner, which delivers them inside the container (never in host argv). `network: none` unless the config lists `allowedDomains`; then `proxy`, after `egressAllowlist(scope, domains)` hands the list to the egress proxy, and refused without one. Closing or removing the server kills its process once. |
| MCP Apps | `readAppResource` serves only `ui://` URIs declared by pinned tools, `text/html;profile=mcp-app`, with `_meta.ui.csp` / `permissions`, provenance `untrusted`; the UI (S12) renders it in a sandboxed frame. |

## Tests

`pnpm --filter @psyche/mcp-host test` (no network beyond `127.0.0.1`):

- `unit.test.ts`: canonical JSON, hash and diff, annotation policy, naming, poisoning probe, env secrets, `srt` settings.
- `http.test.ts`: the HTTP echo server (`test/fixtures/echo-server.ts`, SDK v2 server): discovery, legacy fallback, hashing / revocation, annotation downgrade, MRTR round trip, MCP Apps, agent-core registration, failure states.
- `stdio.test.ts`: `@modelcontextprotocol/server-filesystem` (2026.8.31, an SDK v1 / 2025-era server) on a temp dir; launcher enforcement; vault env injection checked with the secret-leak checker.
- `oauth.test.ts`: mock authorization server (PRM, AS metadata, PKCE token exchange): CIMD flow, token reuse and removal, no DCR, forged `state`.
- `contract.test.ts`: the same `McpHost` assertions against `FakeMcpHost` and `PsycheMcpHost`.
- `container.test.ts`: `containerLauncher` against a fake runner that runs `test/fixtures/probe-server.mjs` (a dependency-free stdio server that lists env and reads files) with only the env it was given: per-server scope, `network none`, secrets out of argv, host env invisible, refusals, egress allowlist hand-off, kill on removal.
- `tests/integration/mcp-sandbox/` (M3 acceptance; runs on CI, locally only with `PSYCHE_SANDBOX_TESTS=1`; skipped without a container backend; builds the `core` image): the probe server in the real container cannot read a planted `$PSYCHE_HOME/vault/vault.db`, `~/.ssh` or the host env.

## Stubbed / not yet

- `ContainerSandboxRunner.openStdio` (S21, #143) is in `@psyche/sandbox`; the Gateway does not compose `containerLauncher({ sandbox: runner })` yet (S01 / INT). `.mcpb` bundles with keychain-backed sensitive config are not done. `srt` is not installed in CI, so that launcher is tested for its argv and settings, not by running under it.
- Server code must already be in the image or the server's `/workspace` (or be fetched through the egress proxy with the registry host allowlisted).
- Token persistence: `McpTokenStore` is injected; the vault-backed store needs a write API from S06.
- Tasks extension (`io.modelcontextprotocol/tasks`) and `subscriptions/listen` beyond `tools` list-changed.
- Re-verifying `tools/list` before every call (a list round trip per call) is not done; the Gateway should refresh on a schedule and on `tools_changed`.
