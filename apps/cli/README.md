# @psyche/cli (`psyche`)

**Owner:** S22 (`prompts/s22-cli-deploy.md`). Features A7, A10, A11, U2 (export), U4 (backups) in [docs/03-feature-spec.md](../../docs/03-feature-spec.md); architecture §3.2, §11, §12, §14; security §10, §14.

`psyche` is a thin client of the Gateway's WebSocket API. It never opens `state/psyche.sqlite`. It pairs as its own device (Ed25519 key in `$PSYCHE_HOME/cli/device.json`, 0600, `deviceFamily: "cli"`), signs the connect challenge, and calls protocol methods with params validated against `@psyche/protocol` before they leave. Side-effecting methods carry an idempotency key. It never presents the handshake secret and is never auto-paired.

Files it touches directly: its device key, `config.json` (`config get|set gateway.*`, doctor, audit), the LaunchAgent plist / systemd unit, `logs/`, and whole directories for `backup` while the Gateway is stopped.

```bash
pnpm --filter @psyche/cli start -- status         # from source (Node 24 runs the TypeScript)
node apps/cli/src/main.ts doctor
```

Release binaries (`bun build --compile`) are attached to each GitHub release; the Docker image ships `psyche` too (`docker compose exec gateway psyche status`).

## First run

```bash
psyche onboard         # data dir → start the service → pair this CLI → a model key → persona basics
```

The first connection prints a pairing code. Approve it on the Gateway host with `psyched devices approve <CODE>` (this makes the first admin), or from an admin device with `psyche pairing approve <CODE>`. Then run the command again; `onboard` waits for the approval.

## Global options and exit codes

`--json` (every command; errors print `{"ok":false,"error":{"code","message","details"}}`), `--url <url>` (default `http://127.0.0.1:7979`, env `PSYCHE_URL`, port from `PSYCHE_PORT`), `--home <dir>` (env `PSYCHE_HOME`, default `~/.psyche`), `--insecure` (allow plain http to a non-loopback host; otherwise refused), `--timeout <s>` (default 15), `-h/--help`.

| Exit | Meaning |
| --- | --- |
| 0 | ok |
| 1 | failure, problems found (doctor, audit, verify), or the Gateway does not offer the method yet (`error.code: "unavailable"`) |
| 2 | usage error |
| 3 | this CLI is not paired yet (`error.details.code` is the pairing code) or was denied |
| 4 | Gateway unreachable |

## Commands

| Command | What it does | Gateway methods |
| --- | --- | --- |
| `onboard [--yes --start --provider anthropic --key-stdin --agent-name X --user-name Y]` | Creates `$PSYCHE_HOME` (0700), starts the service, pairs the CLI (waits for approval), stores one model key in the vault bound to the provider's host, writes `IDENTITY.md` / `USER.md` basics | `vault.status`, `vault.add`, `memory.read`, `memory.write` |
| `start [--psyched path] [--no-wait]` | macOS: writes `~/Library/LaunchAgents/com.psyche.gateway.plist` (same bytes as the desktop), `launchctl bootstrap` + `kickstart`. Linux: writes `~/.config/systemd/user/psyche-gateway.service`, `daemon-reload`, `enable --now`. Elsewhere: prints the Compose command. Waits for `/healthz` | — |
| `stop` | `launchctl bootout` / `systemctl --user stop`; stays stopped ("Quit Psyche entirely") | — |
| `restart` | `launchctl kickstart -k` / `systemctl --user restart` | — |
| `status` | `/healthz`, `/version`, service state, this CLI's pairing and scopes. Exit 1 when unhealthy. Creates no CLI key; with an existing key that is not yet approved, the Gateway re-raises its pending request | `connect` (only if already has a key) |
| `logs [-n N] [-f]` | `$PSYCHE_HOME/logs/gateway*.log`, else `journalctl --user -u psyche-gateway` | — |
| `doctor [--strict] [--offline]` | Config validity, Gateway health and protocol version, bind address, auth (pairing, trusted proxy), sandbox backend, model provider (vault keys or local Ollama), mac helper permissions, vault state, disk space, file modes, service. Exit 1 on a failing check (warnings too with `--strict`) | `settings.get`, `sandbox.status`, `vault.status`, `vault.list`, `nodes.list` |
| `security audit [--fail-at sev]` | Every check in security §10, each with a rule id; the table in [docs/05 §10](../../docs/05-security-and-permissions.md) lists rule ids, data sources and severities. Data the Gateway cannot provide is listed under "Not checked", never passed. Exit 1 at `--fail-at` (default `low`) or above | `settings.get`, `channels.list`, `grants.list`, `devices.list`, `sandbox.status`, `vault.status`, `skills.list`, `browser.realChrome.status`, `mcp.status`, `backup.list`; `run/updater.json` |
| `audit verify` | Hash chain, anchors and their signatures: entries, signed / total anchors, key ids, the seq signing started at. Exit 1 when the chain is broken, an anchor is missing, forged or mismatched, or the log ends before the last signed anchor | `audit.verify` |
| `pairing list [--status s]` | Pairing requests with key fingerprints | `devices.pairing.list` |
| `pairing approve <code> [--scopes a,b] [--admin]` | Approves by code; default scopes read, write, approvals (admin only when asked) | `devices.pairing.list`, `devices.approve` |
| `pairing deny <code> [--reason r]` | | `devices.deny` |
| `devices list [--all]` | Paired devices; `*` marks this CLI | `devices.list` |
| `devices revoke <id> [--yes]` | Permanent | `devices.revoke` |
| `skills list` / `install <source> [--ref r]` / `verify [name] [--strict]` | `install` proposes (folder, `.zip` or git URL): the Gateway fetches and scans it and opens a device-only `skill_install` approval; it installs only after the owner approves in the app. `verify` exits 1 on `hash_mismatch`, `invalid` or `blocked` (with `--strict` also unreviewed or unknown-trust skills) | `skills.list`, `skills.proposeInstall` |
| `automations list [--kind k]` / `run <id>` / `pause <id>` / `resume <id>` | | `automations.list`, `automations.run`, `automations.update` |
| `vault status` / `list [--kind k]` | Metadata only: names, `{{cred:slug}}` placeholders, bindings, use counts | `vault.status`, `vault.list` |
| `vault add <name> [--kind api_key\|login\|note\|ssh_key] [--bind origin\|host\|connector:id]… [--secret-stdin]` | The secret comes from a no-echo prompt or stdin, never argv, and is never printed | `vault.add` |
| `vault import <csv\|-> [--format f]` | 1Password, Bitwarden, Chrome CSV; reminds you to delete the file | `vault.import` |
| `vault lock` / `unlock [--recovery] [--secret-stdin] [--reason r]` | | `vault.lock`, `vault.unlock` |
| `backup create [--out f] [--recipient age1…]… [--recipients-file f] [--passphrase-stdin] [--stop] [--no-encrypt]` | age-encrypted `.tar.gz` of `state/ workspace/ vault/ library/ audit/ config.json` with a SHA-256 manifest (`@psyche/backup`). With the Gateway running, it asks the Gateway for the archive (`backup.create`: online SQLite backup, no downtime, lands in `$PSYCHE_HOME/backups/`); `--out` or `--stop` use the offline path (stop, snapshot, start). Passphrase also from `PSYCHE_BACKUP_PASSPHRASE` | `backup.create` |
| `backup verify <file> [-i identity]` | Decrypts, extracts to a scratch dir inside `$PSYCHE_HOME` (never next to the archive, which may be a synced folder), checks every hash and that nothing extra is present | — |
| `backup restore <file> [-i identity] [--force] [--stop]` | Verifies first; with `--force` moves existing entries to `.pre-restore-<time>/`; tightens modes to 0700/0600 | — |
| `migrate [--check]` | Before starting a new version on old data: which database migrations the Gateway will apply at its next start, refuses data from a newer version (downgrade) or an edited migration, checks `config.json` against this version, warns when the latest backup is over a day old. Reads `_migrations` read-only (node:sqlite; bun:sqlite in the compiled binary, which carries the migration list); never writes. Exit 1 on a blocker | `GET /version` |
| `export [--out dir]` | "Download your data": threads (Markdown + JSON), memory zip, receipts, grants, Library metadata and files, vault references (no values), audit log, `config.json`; `export.json` lists what was skipped | `threads.list`, `chat.export`, `memory.export`, `receipts.list`, `grants.list`, `library.list`, `vault.list` |
| `config get [keys…] [--file]` | Settings from the Gateway; `gateway.*` keys from `config.json` | `settings.get` |
| `config set <key> <value>` | `gateway.*` → `config.json` (validated with the Gateway's rules; restart needed); anything else → `settings.set`. Values parse as JSON when they can | `settings.set` |
| `version` | CLI and Gateway versions, protocol versions | `GET /version` |
| `completion bash\|zsh\|fish` | Completion script generated from the command table | — |

## Public API (`src/index.ts`)

`run(argv, deps?)` (returns the exit code; `deps` replaces env, IO, exec, fetch, prompts, platform, clock), `COMMANDS`, `GatewayClient`, `probeGateway`, `doctorChecks(snapshot)`, `auditRules(snapshot, now)`, `createBackup` / `verifyBackup` / `restoreBackup`, `renderLaunchAgentPlist`, `renderSystemdUnit`, `loadOrCreateIdentity`, `CliError`, `EXIT`, `CLI_VERSION`.

## Layout

`src/cli.ts` (argument routing, help, JSON/human output, exit codes), `src/client.ts` (handshake and calls), `src/identity.ts`, `src/context.ts`, `src/commands/*` (one file per family), `src/snapshot.ts` (what doctor and audit look at), `src/doctor.ts` and `src/audit.ts` (pure rules), `src/backup.ts`, `src/supervisor.ts` (plist, unit, launchctl, systemctl), `src/config-file.ts`.

Tests: `test/commands.test.ts` and `test/pairing.test.ts` (every command, human and `--json`, against `MockGateway` from `@psyche/web/testing`), `test/gateway-integration.test.ts` (the real `apps/gateway` in process: pairing through `psyched devices approve`, settings, doctor, audit), `test/rules.test.ts` (each doctor check and audit rule), `test/backup.test.ts` (round trips, wrong key, tampering), `test/supervisor.test.ts`, `test/deploy.test.ts` (the files in `deploy/` match the renderers; `plutil`, `systemd-analyze`, `docker compose config` when available).

## Stubbed or waiting on others

- `skills.*` is in the protocol (S16, #77) but not yet composed into `psyched`; the commands report "not available on this Gateway" until it is.
- The Gateway on `main` serves devices, settings, threads, chat, nodes and events. `vault.*`, `automations.*`, `memory.*`, `grants.*`, `channels.*`, `sandbox.*` answer `not_implemented` until their packages are composed into `psyched`; doctor and audit list those checks as skipped or "not checked" rather than passing them.
- Model reachability: there is no `models.*` method yet, so doctor checks for a provider key in the vault or a local Ollama, not a live call to the provider.
- Mac helper permission status comes from `nodes.list` (helper online and its capability count); per-permission TCC state needs a helper capability (S14).
