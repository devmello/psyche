# deploy/

**Owner:** S22 (`prompts/s22-cli-deploy.md`). Features A7 (Gateway supervision on macOS), A11 (Linux server packaging), U4 (backups); architecture §3.2 (topologies), §12 (storage); security §10 (control plane), §14 (data handling).

Every recipe runs the same `psyched` with the same rules: it binds `127.0.0.1` only, keeps its state in `$PSYCHE_HOME` (mode 0700), serves a bare unauthenticated `GET /healthz`, and pairs every client (desktop, web, phone, CLI) as a device the owner approves. Remote access always goes through Tailscale Serve, Cloudflare Tunnel + Access, or an SSH tunnel; never through an open port.

| Path | What |
| --- | --- |
| `Dockerfile` | Multi-stage image: esbuild bundles of `psyched` and `psyche`, Node 24 slim, uid 10001, healthcheck on `/healthz` |
| `Dockerfile.dockerignore` | Build-context filter (BuildKit reads it for this Dockerfile) |
| `build/bundle.mjs` | The esbuild step the Dockerfile runs |
| `docker-compose.yml` | Gateway + optional `tailscale`, `cloudflare`, `browser` profiles; named volume for `$PSYCHE_HOME` |
| `.env.example` | Variables Compose reads from `deploy/.env` |
| `launchd/com.psyche.gateway.plist` | The LaunchAgent `psyche start` installs on macOS (example paths) |
| `systemd/psyche-gateway.service` | The systemd user unit `psyche start` installs on Linux (example paths) |
| `tailscale/` | Tailscale Serve config and guide |
| `cloudflare/` | Cloudflare Tunnel + Access guide |
| `backup/` | Backup, restore and verify scripts for Compose deployments |
| `sandbox-image/` | The sandbox container image (S21) |

## Recipe 1: Mac, local (topology A)

The desktop app installs and supervises the Gateway for you (LaunchAgent `com.psyche.gateway`). From a terminal:

```bash
psyche start          # writes ~/Library/LaunchAgents/com.psyche.gateway.plist, bootstraps it, waits for /healthz
psyche onboard        # pairs the CLI, stores a model key in the vault, names the agent
psyche doctor
psyche security audit
```

- The plist: `KeepAlive`, `RunAtLoad`, `PSYCHE_HOME` in the environment, logs in `$PSYCHE_HOME/logs/gateway.{out,err}.log`, no secrets. The desktop writes the same bytes, so the two never fight over it.
- `psyche stop` boots the agent out ("Quit Psyche entirely": it stays stopped until `psyche start`); closing the app window leaves it running. `psyche restart` is `launchctl kickstart -k`.
- `psyche start` finds `psyched` via `--psyched <path>`, `PSYCHE_GATEWAY_BIN`, or `PATH`. The app bundle ships one.
- The first time, approve the CLI on the machine: `psyched devices approve <CODE>` (it prints the code).

## Recipe 2: Linux server with Docker Compose (topologies C and D)

```bash
git clone https://github.com/devmello/psyche && cd psyche
cp deploy/.env.example deploy/.env           # set PSYCHE_IMAGE to a pinned digest for production
docker compose -f deploy/docker-compose.yml up -d --wait
docker compose -f deploy/docker-compose.yml exec gateway psyche status
docker compose -f deploy/docker-compose.yml exec gateway psyche doctor
```

- **Network.** The Gateway refuses any bind but loopback, so the container uses **host networking** and listens on the host's `127.0.0.1:7979`. No port is published. On the server itself, `curl http://127.0.0.1:7979/healthz` answers `{"ok":true}`.
- **Remote access.** Add `--profile tailscale` ([tailscale/README.md](tailscale/README.md)) or `--profile cloudflare` ([cloudflare/README.md](cloudflare/README.md)), or from your laptop: `ssh -L 7979:127.0.0.1:7979 server` and use `http://127.0.0.1:7979`.
- **First admin.** Open the web UI or run the CLI from your laptop through the tunnel; it prints a pairing code. Approve it on the server: `docker compose -f deploy/docker-compose.yml exec gateway psyched devices approve <CODE>`.
- **Pair the Mac as a node** (topology C): open the desktop app, choose "Connect to a remote Gateway", enter the tunnel URL, approve the pairing on the server.
- **Headless browser** (topology D): `--profile browser` runs Playwright's `run-server` on `127.0.0.1:3000`. It has no authentication of its own; keep the host single-tenant.
- **Hardening.** Read-only root filesystem, all capabilities dropped, `no-new-privileges`, uid 10001, logs rotated (10 MB × 5). `$PSYCHE_HOME` is the named volume `psyche-home` at `/data`.
- **Sandbox in Docker.** The sandbox needs a container runtime. Mounting `/var/run/docker.sock` into the Gateway works but gives whoever controls the Gateway process root on the host; the line is commented out in the Compose file with that warning. Prefer a rootless Podman socket or a separate sandbox host.
- **Upgrades.** Pin `PSYCHE_IMAGE` to a digest from the release notes, `docker compose pull && docker compose up -d --wait`. Back up first.
- **Verify the image** (keyless cosign signature from the release workflow):
  ```bash
  cosign verify ghcr.io/devmello/psyche-gateway@sha256:<digest> \
    --certificate-identity-regexp '^https://github.com/devmello/psyche/\.github/workflows/release\.yml@refs/tags/v' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

## Recipe 3: Linux host without Docker (systemd user unit)

```bash
psyche start --psyched /usr/local/bin/psyched   # writes ~/.config/systemd/user/psyche-gateway.service, enable --now
loginctl enable-linger "$USER"                   # keep it running after logout
psyche logs -f                                   # journalctl --user -u psyche-gateway
```

The unit restarts on failure, sets `UMask=0077`, `NoNewPrivileges`, and passes `PSYCHE_HOME`. Remote access as in recipe 2 (`tailscale serve`, `cloudflared`, or SSH).

## Backups (U4)

Archives hold `state/` (SQLite and the channel sessions in `state/channels/`), `workspace/`, `vault/`, `library/`, `audit/` and `config.json`, with a SHA-256 manifest, gzip'd and encrypted with [age](https://age-encryption.org) (passphrase or X25519 recipients). Not included: the device keys in `cli/`, sockets in `run/`, logs, browser profiles, sandbox workspaces, VM disks. A live WAL database is not a consistent snapshot and the CLI never opens the database, so a backup stops the Gateway for its duration.

```bash
# Mac or systemd host
psyche backup create --stop --recipient age1…            # or a passphrase prompt
psyche backup verify ~/.psyche/backups/psyche-<time>.tar.gz.age -i key.txt
psyche backup restore psyche-<time>.tar.gz.age --stop --force -i key.txt

# Compose
sudo install -d -o 10001 -g 10001 -m 700 /srv/psyche-backups
deploy/backup/backup.sh /srv/psyche-backups age1…
deploy/backup/verify.sh /srv/psyche-backups/psyche-<time>.tar.gz.age key.txt
deploy/backup/restore.sh /srv/psyche-backups/psyche-<time>.tar.gz.age key.txt
```

Schedule it with cron or a systemd timer, e.g. `15 3 * * * /opt/psyche/deploy/backup/backup.sh /srv/psyche-backups age1…`. Restoring on another machine needs the vault **recovery key** (`psyche vault unlock --recovery`): the keychain slot does not travel. Keep the age identity or passphrase and the recovery key outside the backup.

## Release artifacts

`.github/workflows/release.yml` (tag `v*`): the multi-arch Gateway image on GHCR signed with cosign, `psyche` binaries for macOS arm64/x64 and Linux x64/arm64, the unsigned desktop package, and release notes from changesets. On pull requests that touch `deploy/` or `apps/cli/`, its `deploy-smoke` job builds the image, runs `docker compose up --wait`, and checks `psyche status` inside and outside the container.
