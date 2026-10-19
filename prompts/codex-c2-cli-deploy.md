# Codex C2 — CLI, Docker, Compose, launchd, release pipeline

You are working on Psyche, an open-source self-hosted personal AI agent (read `README.md`). Your task is self-contained: `apps/cli` (the `psyche` command), `deploy/` (Dockerfile for the Gateway, Compose, launchd plists, systemd unit, Tailscale Serve and Cloudflare Access examples) and the release workflow. Start after `apps/gateway` has merged with its API. Work on branch `codex/c2-cli-deploy`. Edit only those paths, `.github/workflows/release.yml`, and `docs/status/c2.md`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §3.2 (topologies C and D), §11 (API), §12 (storage layout)
3. `docs/05-security-and-permissions.md` §10 (control plane and remote access), §14 (data handling, backups)
4. `docs/03-feature-spec.md` rows A7, A10, A11, U2 (export), U4 (backups)
5. `apps/gateway/README.md` (config keys and API) and `packages/protocol` (method list)
6. `research_notes/Psyche personal agent landscape/shopping_messaging_server_docs.md` KQ3 (self-hosting patterns: loopback daemon in Compose, Tailscale Serve identity headers, Cloudflare Access, passkeys, backups)

## Build
- **CLI** (`psyche`): a thin client of the Gateway WS API (never touches the database directly): `onboard` (guided config: data dir, model/provider keys stored via `vault.*`, persona basics), `start | stop | restart | status` (macOS: LaunchAgent management; Linux: systemd user unit or Compose hints), `doctor` (config validity, bind address, auth mode, sandbox backend, model reachability, permissions status from the helper if present, disk usage; exit non-zero on problems), `security audit` (flags `dmPolicy: open`, non-loopback bind without auth, sandbox disabled, unverified skills, standing grants without expiry, telemetry enabled), `pairing list|approve|deny`, `devices list|revoke`, `skills list|install|verify`, `automations list|run|pause`, `vault list|add|import|lock|unlock` (metadata and secure prompts only), `backup create|restore`, `export`, `logs`, `config get|set`, `version`; `--json` output for every command; shell completions.
- **Deploy**: `deploy/Dockerfile` (multi-stage, nonroot, Node 24, healthcheck on `/healthz`), `deploy/docker-compose.yml` (Gateway bound to loopback inside the network, named volume for `$PSYCHE_HOME`, optional sandbox-in-docker socket mount documented as a risk, optional Playwright browser sidecar service), `deploy/launchd/com.psyche.gateway.plist` (KeepAlive, logs, `PSYCHE_HOME`), `deploy/systemd/psyche-gateway.service`, `deploy/tailscale/README.md` (Serve with identity headers → trusted-proxy mode that only unlocks passkey login, never API authorization), `deploy/cloudflare/README.md` (Tunnel + Access), `deploy/backup/` scripts (snapshot `state/`, `workspace/`, `vault/`, `library/`, channel sessions; restore; verify).
- **Release workflow**: GitHub Actions that builds the Gateway Docker image (multi-arch, signed with cosign), the CLI binaries (macOS arm64/x64, Linux x64/arm64 via a single-binary bundler), and packages the desktop app when the desktop build is available (unsigned artifact in CI; signing/notarization steps documented with secrets names); `CHANGELOG` from changesets.

## Tests
CLI tests against a mock Gateway (every command's happy path and `--json`), `doctor` and `security audit` rule tests, Compose smoke test in CI (`docker compose up`, wait for health, `psyche status`), backup/restore round trip on a fixture data dir, plist and unit file validation.

## Definition of done
Green CI; `apps/cli/README.md` with every command; `deploy/README.md` with the three deployment recipes; `docs/status/c2.md`.
