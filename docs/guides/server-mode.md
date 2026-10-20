# Server mode

You can run the Gateway (`psyched`) on a Linux server or a Mac without a screen, and reach it from the desktop app, a browser or the CLI. This guide covers Docker Compose, the systemd and launchd units, Tailscale and other ways in, pairing clients, backups and restore, logs, and what server mode does not support yet.

## How it works

- The Gateway binds `127.0.0.1` only. It refuses any other address ("Refusing to bind …"), so nothing listens on a public interface.
- You reach it through a proxy or tunnel on the same machine: Tailscale Serve, Cloudflare Tunnel with Cloudflare Access, or an SSH tunnel.
- Every client (desktop, browser, CLI) pairs as a device that you approve. Identity headers from a proxy never authorize anything on their own.
- `GET /healthz` answers `{"ok":true}` without authentication. Everything else needs a paired device.

Before you start:

- There is no release yet: no published container image, no `psyche` or `psyched` binaries. You build from a source checkout.
- The model is set with environment variables, as in [getting-started.md](getting-started.md#2-choose-a-model-and-start-the-gateway). Model keys in the vault are not available yet.

## Docker Compose on Linux

The Compose file runs the Gateway with host networking, so it listens on the host's `127.0.0.1:7979` and no port is published. Host networking needs Linux (or Docker Desktop with host networking turned on).

1. Get the code:

   ```bash
   git clone https://github.com/devmello/psyche
   ```

   ```bash
   cd psyche
   ```

2. Create the environment file. Compose reads `deploy/.env` automatically; never commit it.

   ```bash
   cp deploy/env.example deploy/.env
   ```

3. Give the Gateway its model. The Compose file sets only `PSYCHE_LOG_LEVEL` in the Gateway's environment, so add your model variables under the `gateway` service's `environment:` in `deploy/docker-compose.yml`:

   ```yaml
       environment:
         PSYCHE_LOG_LEVEL: ${PSYCHE_LOG_LEVEL:-info}
         PSYCHE_MODEL: ${PSYCHE_MODEL}
         ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
   ```

   Then put the values in `deploy/.env`:

   ```
   PSYCHE_MODEL=anthropic/claude-sonnet-5-5
   ANTHROPIC_API_KEY=<your key>
   ```

   This edits a file the repository ships, so `git pull` may conflict with it. Keep the change somewhere and re-apply it after updating, until the Compose file passes the model variables itself.

   Use `OPENAI_API_KEY` for OpenAI. For Ollama on the same host, use `PSYCHE_MODEL=ollama/<model>` and no key; set `PSYCHE_OLLAMA_URL` if Ollama is not at its default address. Without a model the Gateway still starts and answers "No model is configured yet."

4. Build the image and start the Gateway:

   ```bash
   docker compose -f deploy/docker-compose.yml up -d --build --wait
   ```

5. Check it:

   ```bash
   docker compose -f deploy/docker-compose.yml exec gateway psyche status
   ```

   ```bash
   curl http://127.0.0.1:7979/healthz
   ```

   ```bash
   docker compose -f deploy/docker-compose.yml exec gateway psyche doctor
   ```

`psyche doctor` lists checks it could not run as skipped rather than passing them.

What the Compose setup gives you:

- State in the named volume `psyche-home`, mounted at `/data` (the container's `$PSYCHE_HOME`).
- A read-only root filesystem, all capabilities dropped, `no-new-privileges`, user id 10001, and logs rotated at 10 MB × 5.
- A health check on `/healthz` and `restart: unless-stopped`.

Gateway settings such as `gateway.publicOrigin` live in `config.json` on the volume. Set them with the CLI inside the container, then restart:

```bash
docker compose -f deploy/docker-compose.yml exec gateway psyche config set gateway.publicOrigin https://psyche.<your-tailnet>.ts.net
```

```bash
docker compose -f deploy/docker-compose.yml restart gateway
```

Do not set `PSYCHE_HOST` or `PSYCHE_PORT` in the Compose file: environment variables override `config.json`.

To upgrade, make a backup, update your checkout, and run the `up -d --build --wait` command again.

Two parts of the Compose file are not used by the Gateway yet:

- The commented Docker socket line is for running sandboxed commands. The Gateway does not run a sandbox yet. Leave it commented: the socket gives whoever controls the Gateway root on the host.
- `--profile browser` starts a headless Playwright server on `127.0.0.1:3000`. The Gateway does not connect to it yet; the agent's browser runs only in the desktop app.

## systemd and launchd

`psyche start` installs the Gateway as a user service and waits for `/healthz`:

- On Linux it writes `~/.config/systemd/user/psyche-gateway.service`, then runs `daemon-reload` and `enable --now`.
- On macOS it writes `~/Library/LaunchAgents/com.psyche.gateway.plist` and starts it with `launchctl`. Its logs go to `$PSYCHE_HOME/logs/gateway.out.log` and `gateway.err.log`.
- `psyche stop` stops it and keeps it stopped; `psyche restart` restarts it; `psyche status` reports health, the service state and the CLI's pairing.

On Linux, keep a user service running after you log out:

```bash
loginctl enable-linger "$USER"
```

Two limits make these units hard to use today:

- `psyche start` needs a `psyched` executable: `--psyched <path>`, `PSYCHE_GATEWAY_BIN`, or `psyched` on your `PATH`. No release ships one yet.
- The unit and the plist set only `PSYCHE_HOME`. A Gateway started this way has no model, because model keys come only from the environment. `psyche start` rewrites the file whenever it differs from what it would write, so hand edits do not last.

Until that changes, use Docker Compose on Linux. On a Mac without a screen, run the Gateway from the source checkout in a terminal session that stays open:

```bash
PSYCHE_MODEL=anthropic/claude-sonnet-5-5 ANTHROPIC_API_KEY=<your key> pnpm --filter @psyche/gateway start
```

## Reaching the Gateway

### SSH tunnel

The simplest way in, with nothing to install on the server. On your laptop:

```bash
ssh -L 7979:127.0.0.1:7979 server
```

While it runs, the Gateway is at `http://127.0.0.1:7979` on your laptop.

### Tailscale Serve

Tailnet-only HTTPS in front of the Gateway. Funnel is off in `deploy/tailscale/serve.json`, so nothing is reachable from the public internet.

1. In the Tailscale admin console, create the tag `tag:psyche` and a one-off, pre-approved auth key with that tag. Turn on HTTPS certificates for the tailnet.
2. Add the key to `deploy/.env`:

   ```
   TS_AUTHKEY=tskey-auth-…
   TS_HOSTNAME=psyche
   ```

3. Start Tailscale, tell the Gateway its public origin, and restart it:

   ```bash
   docker compose -f deploy/docker-compose.yml --profile tailscale up -d
   ```

   ```bash
   docker compose -f deploy/docker-compose.yml exec gateway psyche config set gateway.publicOrigin https://psyche.<your-tailnet>.ts.net
   ```

   ```bash
   docker compose -f deploy/docker-compose.yml restart gateway
   ```

4. Open `https://psyche.<your-tailnet>.ts.net` from a device on the tailnet and pair it (below).

Without Docker, on the Gateway's host:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7979
```

Then set `gateway.publicOrigin` with `psyche config set` and restart the Gateway.

### Cloudflare Tunnel and Access

Use this when you need a hostname a browser can reach without joining a tailnet. `cloudflared` connects out to Cloudflare, and Cloudflare Access decides who may reach the hostname. Put `CLOUDFLARE_TUNNEL_TOKEN` in `deploy/.env` and start the `cloudflare` profile. The steps are in `deploy/cloudflare/README.md`. Access keeps strangers out; it does not authorize the API, so every client still pairs.

## Pairing clients with a server

### The first admin device

The first device you approve on the server becomes your admin. The CLI makes a good first device, because its key is kept on disk.

1. Open a tunnel (or use your tailnet URL).
2. From a source checkout on your laptop, run any command that needs the Gateway:

   ```bash
   node apps/cli/src/main.ts devices list
   ```

   The CLI is not paired yet, so it prints a pairing code and exits. Add `--url https://psyche.<your-tailnet>.ts.net` when you go through Tailscale.

3. Approve the code on the server:

   ```bash
   docker compose -f deploy/docker-compose.yml exec gateway psyched devices approve <CODE>
   ```

   Without a list of scopes after the code, this grants every scope, including admin.

4. Run the CLI command again.

### More devices

Every new client shows a pairing code. Approve it from the CLI:

```bash
node apps/cli/src/main.ts pairing list
```

```bash
node apps/cli/src/main.ts pairing approve <code>
```

This grants read, write and approvals. Add `--admin` to grant admin too. You can also approve in Settings → Devices & nodes, under "Waiting to pair", from a device that is already admin. Approve only if the same code shows on the other device.

### The web client

Open the tunnel or tailnet URL in a browser. The page shows "Approve this device from a paired device to continue" and a pairing code. Approve it as above.

The web client keeps its device key in memory, so every reload is a new device that needs approving again. Passkey sign-in for the web is not available yet.

### The desktop app

On the Mac, start the app so that it uses the remote Gateway and never starts its own. Through an SSH tunnel:

```bash
PSYCHE_GATEWAY_MODE=external pnpm --filter @psyche/desktop start
```

Through Tailscale:

```bash
PSYCHE_GATEWAY_MODE=external PSYCHE_GATEWAY_ORIGIN=https://psyche.<your-tailnet>.ts.net pnpm --filter @psyche/desktop start
```

The app shows a pairing code; approve it on the server or from the CLI.

With a remote Gateway, the agent has no browser and no Mac helper: both connect to the Gateway over local sockets in `$PSYCHE_HOME/run/`, which a Gateway on another machine cannot use.

## Backups and restore

A backup is an encrypted `.tar.gz` of `state/`, `workspace/`, `vault/`, `library/`, `audit/` and `config.json`, with a SHA-256 manifest. It is encrypted with [age](https://age-encryption.org), to a passphrase or to age recipients. Device keys, sockets, logs, browser profiles and sandbox workspaces are not included. Keep the age identity or the passphrase somewhere other than the backup.

### From the app

Settings → Data controls → Backups:

- "Back up now" with a passphrase of at least 12 characters, or "Skip encryption". The passphrase is sent once and never stored. The Gateway keeps running.
- Each backup in the list has Verify and Delete.
- Archives land in `$PSYCHE_HOME/backups/`.
- "Scheduled backups" (Off, Daily, Weekly) is saved but not applied yet. Use cron (below).

Creating, verifying and deleting backups needs a device paired as admin.

### From the CLI

With the Gateway running, `psyche backup create` asks the Gateway for the archive, with no downtime:

```bash
node apps/cli/src/main.ts backup create --recipient age1…
```

Use `--passphrase-stdin` or `PSYCHE_BACKUP_PASSPHRASE` for a passphrase instead. `--out <file>` or `--stop` take the offline path, which needs the Gateway stopped; `--stop` stops the service for the backup and starts it again.

Check a backup without restoring it:

```bash
node apps/cli/src/main.ts backup verify <file> -i key.txt
```

### With Compose

The scripts in `deploy/backup/` stop the Gateway, write `psyche-<time>.tar.gz.age` and start it again:

```bash
sudo install -d -o 10001 -g 10001 -m 700 /srv/psyche-backups
```

```bash
deploy/backup/backup.sh /srv/psyche-backups age1…
```

```bash
deploy/backup/verify.sh /srv/psyche-backups/psyche-<time>.tar.gz.age key.txt
```

To schedule it, add a cron line such as `15 3 * * * /opt/psyche/deploy/backup/backup.sh /srv/psyche-backups age1…`.

### Restore

Restore always goes through the CLI with the Gateway stopped. It verifies every file first, and with `--force` it moves existing state aside to `.pre-restore-<time>/` in `$PSYCHE_HOME`.

```bash
node apps/cli/src/main.ts backup restore <file> --stop --force -i key.txt
```

With Compose:

```bash
deploy/backup/restore.sh /srv/psyche-backups/psyche-<time>.tar.gz.age key.txt
```

`--stop` stops a launchd or systemd service. A Gateway you run in a terminal has to be stopped by hand first (Ctrl-C).

## Logs

The Gateway writes JSON lines with metadata only: never message bodies, tool arguments or secrets. `PSYCHE_LOG_LEVEL` sets the level (default `info`).

| Where the Gateway runs | Where the logs go | How to read them |
| --- | --- | --- |
| A terminal | Standard error | In that terminal |
| LaunchAgent (macOS) | `$PSYCHE_HOME/logs/gateway.out.log` and `gateway.err.log` | `psyche logs -n 200`, or `psyche logs -f` to follow |
| systemd user unit | The journal | `psyche logs -f` (it reads `journalctl --user -u psyche-gateway`) |
| Docker Compose | Container output | `docker compose -f deploy/docker-compose.yml logs gateway` |

Settings → About has a log viewer with level, subsystem and search filters. It reads `$PSYCHE_HOME/logs/gateway*.log`, so it shows lines only when the Gateway runs as a LaunchAgent; under systemd, Docker or a terminal it is empty.

## Checks

```bash
node apps/cli/src/main.ts doctor
```

```bash
node apps/cli/src/main.ts security audit
```

`doctor` checks the config, the Gateway's health and protocol version, the bind address, pairing, the vault, disk space and file modes. `security audit` flags risky setups, such as plain HTTP to a remote host, trusted-proxy mode without CIDRs, public ingress without passkeys, or standing grants without an expiry. Both list what they could not check.

## Not supported yet

- A published container image, release binaries, or a packaged `psyched`.
- Binding the Gateway to anything but loopback, or a container network with token auth. Compose uses host networking instead.
- Passkey sign-in for the web client, and Cloudflare Access token verification.
- Model keys from the vault, and setting the vault up from the app or the CLI.
- The agent's browser on a server: the headless browser profile is not used.
- Using a Mac's helper (approval notifications, Touch ID, apps) from a server Gateway.
- Creating the Telegram channel (see [connectors.md](connectors.md#telegram)).
- Scheduled backups from Settings, and the in-app log viewer under systemd or Docker.
- Running sandboxed commands.
