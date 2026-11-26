# Server mode

You can run the Gateway (`psyched`) on a Linux server or a Mac without a screen, and reach it from the desktop app on another computer, the iPhone app or the CLI. The easiest way is the `psyche-server` package on Ubuntu or Debian. This guide covers that package, then Docker Compose, the systemd and launchd units, Tailscale and other ways in, pairing clients, backups and restore, logs, and what server mode does not support yet.

## Quick start: an Ubuntu server and your Mac

You need Ubuntu or Debian, a user on the server who can use `sudo`, and a Mac on the same network with the Psyche app. Without a model key the first reply is "No model is configured yet", which is expected.

1. Install the package on the server, as the user Psyche will run for. Use the `.deb` from the release, or build one with `node deploy/linux-server/build.mjs` (see the header of that file for its options):

   ```bash
   sudo apt install ./psyche-server-<version>-linux-<arch>.deb
   ```

   It installs `psyche`, `psyched` and a helper. It turns on linger for the user who ran `sudo`, so the Gateway keeps running after you log out. It recommends `avahi-daemon`, so the Mac can find the server by name. It can't be installed next to the desktop package.

2. Read the setup code the install printed:

   ```text
   Setup code: 7K3QM-XR2TD
   ```

   Then the Gateway starts, waiting to be set up. The code works once, for 24 hours. If you lost it or it expired, run `psyche setup code` as that user for a new one (the old one stops working). `psyche status` says whether a code is waiting.

3. On the Mac, open Psyche and choose **Connect to a Psyche server**. Once Psyche is set up on the Mac, use Settings → Server & remote access → Gateways on this computer → **Set up a remote server** instead.
   - Psyche lists the servers on the network that are waiting for setup. Pick yours, or type its address (`ip addr` on the server shows it).
   - Confirm the address, then type the code.
   - Both sides prove they know the code before either trusts the other. Then the Mac pins the server's key and certificate and becomes its first admin.

4. Press **Switch to** the server. Onboarding runs on the server: your agent's name, your name and a model provider. It also asks about **Keep this server reachable on my network**, which is on by default. Turn it off only if you reach the server another way, such as [Tailscale Serve](#tailscale-serve): when onboarding finishes, the server stops listening on the network and the Mac disconnects.

5. Check it: send a message.

If something goes wrong:
- **"That code isn't right":** check it on the server. After a few wrong tries, the server makes you wait a minute.
- **"That code has expired":** run `psyche setup code` on the server and type the new code.
- **No server is listed:** type its address. Ubuntu Server doesn't answer `.local` names or show up on the network without an mDNS responder: `sudo apt install avahi-daemon`.
- **"That server is already set up":** it was set up from the terminal or another computer. Add it with a pairing link (below).

Once a server has an admin, set up from the app or from the terminal, it never waits for a setup code again.

### Setting it up from the terminal instead

Use this if you'd rather not use the setup code, or the Mac can't reach the server on the network.

1. Set it up, as the user Psyche runs for (not root):

   ```bash
   psyche setup --yes --provider skip --start --no-wait
   ```

   Leave out `--yes --provider skip` to answer the prompts and give it a model key instead. The command starts the Gateway and prints a pairing code for this CLI. Approve it on the server:

   ```bash
   psyched devices approve <CODE>
   ```

   Then run `psyche setup --yes --provider skip` again, and check that `psyche status` says healthy and paired. Once the CLI is the server's admin, the setup code stops working.

2. Let computers on your network connect, and name the interface they reach the server on:

   ```bash
   psyche lan on --interface eth0
   ```

   The pairing link names the server as `https://<hostname>.local:7979`, so the Mac needs `avahi-daemon` on the server to find it by that name (see above). If you prefer Tailscale to the local network, skip this step and the next one's `--lan`, and follow [Tailscale Serve](#tailscale-serve) below.

3. Make a pairing link on the server:

   ```bash
   psyche devices link --lan
   ```

   It prints a `psyche-pair:v2:…` link that works once, for ten minutes. Anyone holding it can pair until then, so don't paste it anywhere shared.

4. On the Mac, open Psyche, then Settings → Server & remote access → Gateways on this computer → Add a Gateway.
   - Paste the link.
   - Check the key fingerprint it shows against the one on the server (`psyched identity show`).
   - Add it, then press Switch.

   The Mac pins the server's key and certificate and pairs by itself, because the link carries the one-time token.

5. Check it: send a message. Without a model key the reply is "No model is configured yet." Give the Gateway a model through `psyche setup` (run it without `--provider skip`).

### If the Mac cannot reach the server by name

You can add the server by its address instead, without a link:

1. In Add a Gateway, type `https://<server ip>:7979` (find the address with `ip addr`).
2. The Mac shows a pairing code and the server's key fingerprint. On the server, compare that fingerprint with the one `psyched identity show` prints. They must match.
3. On the server, approve the code:

   ```bash
   psyche pairing approve <CODE>
   ```

   Run `psyche pairing list` to see waiting codes.

### Checking from a script

`apps/desktop/scripts/remote-e2e.ts` is a manual check that uses the desktop app's own connection code. It pairs with a link or a typed address, or sets up a fresh server with its setup code (`--claim <code> <address>`). Then it lists and creates a thread and sends one message. See the comment at the top of the file for how to run it. It is not part of any test suite.

Everything below applies to other setups, and to using the Gateway beyond this quick start.

## How it works

- The Gateway binds `127.0.0.1` only, unless you turn LAN on for one interface (`psyche lan on`). It refuses any other address ("Refusing to bind …").
- Otherwise, you reach it through a proxy or tunnel on the same machine: Tailscale Serve, Cloudflare Tunnel with Cloudflare Access, or an SSH tunnel.
- Every client (desktop, iPhone, CLI) pairs as a device that you approve. Identity headers from a proxy never authorize anything on their own.
- `GET /healthz` answers `{"ok":true}` without authentication. Everything else needs a paired device.

Before you start with the other setups:

- There is no published container image. The Docker Compose and source-checkout steps below build from a source checkout. [install.md](install.md) describes the release path.
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
- On macOS it writes `~/Library/LaunchAgents/com.psyche.gateway.plist` and starts it with `launchctl`. Its logs go to `$PSYCHE_HOME/logs/gateway.log`, which the Gateway rotates itself (10 MB, three files). `gateway.err.log` holds crash output only, and `gateway.out.log` holds stdout.
- `psyche stop` stops it and keeps it stopped; `psyche restart` restarts it; `psyche status` reports health, the service state and the CLI's pairing.

On Linux, keep a user service running after you log out:

```bash
loginctl enable-linger "$USER"
```

Two limits make these units hard to use by hand (the `psyche-server` package sets them up for you):

- `psyche start` needs a `psyched` executable: `--psyched <path>`, `PSYCHE_GATEWAY_BIN`, or `psyched` on your `PATH`. The `psyche-server` package puts one on your `PATH`.
- The unit and the plist set only `PSYCHE_HOME`. A Gateway started this way has no model, because model keys come only from the environment. `psyche start` rewrites the file whenever it differs from what it would write, so hand edits do not last.

Until that changes, use the `psyche-server` package or Docker Compose on Linux. On a Mac without a screen, run the Gateway from the source checkout in a terminal session that stays open:

```bash
PSYCHE_MODEL=anthropic/claude-sonnet-5-5 ANTHROPIC_API_KEY=<your key> pnpm --filter @psyche/gateway start
```

### A headless Linux Host

A Linux Host is headless when logind reports no graphical session for its user (an SSH-only box, or linger without a login). The Gateway asks logind every few seconds. Its own environment doesn't count. On a headless Host:

- The agent's browser is headless Chromium. It has no screen, so it never shares one with computer use. It gets a private home and runtime dir under `$PSYCHE_HOME/browser/` (0700), its own certificate store and no session bus. Install Chromium (`apt install chromium`), or name the binary with `PSYCHE_CHROMIUM`. You can't take over its tabs yet, so `browser.request_control` answers that there is no pane and the agent asks in chat. Checkout in the browser needs the desktop app connected.
- Computer use runs on the helper's private screen. Watch it and take over from a paired desktop. Stopping that screen, and answering its unsaved-changes card, need a device allowed to approve.
- A payment needs a passkey. Without one it fails before any card is shown.

These variables change that. Set them only in the service's environment (`systemctl --user edit psyche-gateway`, then `Environment=` under `[Service]`), never in a file the agent can write. The Gateway reads them once at start.

| Variable | Values | Effect |
| --- | --- | --- |
| `PSYCHE_BROWSER_DRIVER` | `bridge`, `server` | `bridge`: only a desktop app's browser, never headless Chromium. `server`: headless Chromium on Linux even with a graphical session. Unset: logind decides. |
| `PSYCHE_PAYMENT_PRESENCE` | `passkey` | Payments need a passkey on any Host, not only a headless one. |
| `PSYCHE_CHROMIUM` | a path | The Chromium binary for the headless browser. Unset: the first of `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`, `/usr/bin/google-chrome-stable` and `/usr/bin/google-chrome` that exists. |

## The vault key

On Linux the vault's key lives in a key file. Unless `PSYCHE_VAULT_KEY_FILE` names one, psyched creates `$PSYCHE_HOME/secrets/vault.key` the first time it starts: 32 random bytes, mode 0600, in a 0700 folder. The vault can then be created and unlocks at start without a prompt. Under Compose the file is `/data/secrets/vault.key` on the `psyche-home` volume.

The key sits beside the data it protects, so anyone who can read `$PSYCHE_HOME` can open the vault. Full-disk encryption (LUKS) is what protects it at rest. Backups do not include `secrets/`: after a restore on another machine, unlock with the recovery key (`psyche vault unlock --recovery`).

To keep the key off the data volume, store it in a file that only the Gateway's user can read (mode 0600, owned by that user) and set `PSYCHE_VAULT_KEY_FILE` to its path in the service's environment. psyched refuses a key file that other users can read. A vault that already uses another slot is never switched to a key file; setting up or unlocking the vault then fails with that reason.

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

4. From a device on the tailnet, use `https://psyche.<your-tailnet>.ts.net` as the Gateway address in the Psyche app and pair it (below).

Without Docker, on the Gateway's host:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7979
```

Then set `gateway.publicOrigin` with `psyche config set` and restart the Gateway.

### Cloudflare Tunnel and Access

Use this when you need a hostname the Psyche apps can reach without joining a tailnet. `cloudflared` connects out to Cloudflare, and Cloudflare Access decides who may reach the hostname. Put `CLOUDFLARE_TUNNEL_TOKEN` in `deploy/.env` and start the `cloudflare` profile. The steps are in `deploy/cloudflare/README.md`. Access keeps strangers out; it does not authorize the API, so every client still pairs.

The Gateway checks Access's assertion itself. Set `gateway.cloudflareAccess` in `config.json` to your team domain and the application's AUD tag:

```json
{ "gateway": { "cloudflareAccess": { "teamDomain": "myteam.cloudflareaccess.com", "audience": "<AUD tag>" } } }
```

Every forwarded or remote connection then needs a `Cf-Access-Jwt-Assertion` that verifies against the team's keys (signature, audience, issuer, expiry), or it gets 401. The verified email is shown on the pairing card.

### Container bind (`PSYCHE_BIND=container`)

Without host networking, the Gateway can listen on its container interface instead of loopback:

- `PSYCHE_BIND=container` binds the container's own address (or `PSYCHE_HOST`, which must be a real interface address; `0.0.0.0`, `::` and loopback are refused).
- `PSYCHE_GATEWAY_TOKEN_FILE` is required: a Compose secret holding at least 32 characters, mode 0600 or 0400, owned by the Gateway's user. Looser permissions stop the Gateway at startup.
- Set `gateway.trustedProxy.trustedProxies` to the proxies' addresses on that network, and `gateway.trustedProxy.tailscaleProxies` to the Tailscale container's.

Who gets through:

| Peer | Needs |
| --- | --- |
| A trusted proxy (`trustedProxies`) | A verified identity: a valid Cloudflare Access assertion, or the `Tailscale-User-Login` header from a peer in `tailscaleProxies`. A proxy connection with neither is refused. |
| Anything else (the CLI, a script) | `Authorization: Bearer <token>` |

To narrow who may try at all, set `gateway.trustedProxy.allowedLogins` to a list of logins (`you@example.com`, compared without regard to case). It is a Tailscale list: a forwarded connection passes when its `Tailscale-User-Login` is on it and the direct peer is in `tailscaleProxies` (on the loopback bind, with Tailscale Serve on the host, that defaults to loopback). A verified Cloudflare Access email is matched against the same list, so Access users are not locked out by it. Everything else, a missing login included, gets no WebSocket upgrade. It needs `trustedProxy.enabled`. A direct connection on this computer is not forwarded, so it is unaffected. A login on the list is not trusted for anything: the device still has to pair.

`/healthz` stays open for the Compose healthcheck. This only gates the transport: every device still pairs, and its scopes still apply. Another container on the same network gets nothing without the token or a proxy identity.

Put the Gateway and the proxies on an internal network (`internal: true`) and pin `PSYCHE_HOST` to the Gateway's address there. The Gateway still needs outbound access for model APIs and connectors, so it also joins an egress network; it never listens on that one. The shipped Compose file still uses host networking until S22 switches it.

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

### Passkeys

Psyche does not open in a browser, and the Gateway serves no web UI. Passkeys are added from the Psyche desktop app on a remote Mac. The passkey proves you are present for approvals that need authentication, and for security settings once any passkey exists.

1. Set the public origin, so the passkey is bound to your hostname. Either `{"gateway": {"publicOrigin": "https://psyche.example.com"}}` in `config.json`, or `PSYCHE_PUBLIC_ORIGIN`. It must be `https://`; `http://localhost` works for development. Changing the hostname later invalidates every passkey.
2. In the desktop app on the remote Mac, add a passkey (Settings → Devices & nodes → Passkeys). The Gateway stores it for that device only, with at most 20 per device.
3. To add or remove another passkey on the same device, you first confirm with an existing one. A stolen device key alone cannot swap in someone else's passkey.

Once a paired device has a passkey, changing a security setting (permissions, exec, vault, devices, gateway, owner identities) shows an approval card first. Approve it with your passkey or with Touch ID on the Mac; the change then goes through. Failed attempts are limited to 20 per address or device per 5 minutes. Revoking a device ends its passkeys.

### The desktop app

The normal way to use another computer's Gateway is the saved Gateways in Settings → Server & remote access: [remote-gateway.md](remote-gateway.md). The environment variables below stay for development and tests.

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

[backup-restore.md](backup-restore.md) covers backups, schedules, verification and restore for every setup. From a source checkout, run the CLI as `node apps/cli/src/main.ts` wherever that guide says `psyche`, for example:

```bash
node apps/cli/src/main.ts backup create --recipient age1…
```

```bash
node apps/cli/src/main.ts backup restore <file> --stop --force -i key.txt
```

With Compose, the scripts in `deploy/backup/` work the same from a source checkout. `--stop` stops a launchd or systemd service; a Gateway you run in a terminal has to be stopped by hand first (Ctrl-C).

## Logs

The Gateway writes JSON lines with metadata only: never message bodies, tool arguments or secrets. `PSYCHE_LOG_LEVEL` sets the level (default `info`).

| Where the Gateway runs | Where the logs go | How to read them |
| --- | --- | --- |
| A terminal | Standard error | In that terminal |
| LaunchAgent (macOS) | `$PSYCHE_HOME/logs/gateway.log` (crashes in `gateway.err.log`) | `psyche logs -n 200`, or `psyche logs -f` to follow |
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

- A published container image.
- The shipped Compose file on the container bind: it still uses host networking (see "Container bind").
- Model keys from the vault, and setting the vault up from the app or the CLI.
- The agent's browser on a server: the headless browser profile is not used.
- Using a Mac's helper (approval notifications, Touch ID, apps) from a server Gateway.
- Scheduled backups from Settings, and the in-app log viewer under systemd or Docker.
- Running sandboxed commands.
