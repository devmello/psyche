# Server mode (INT-2, temporary)

Topology C (architecture §3.2, feature N12): `psyched` in Docker Compose on a Linux box, Tailscale Serve in front, Telegram terminating on the server, the Mac paired as a node.

This folder is a stopgap. S22's `deploy/docker-compose.yml` and `deploy/Dockerfile` (PR #60, branch `ws/s22-cli-deploy`) have not merged. `compose.yaml` copies their shape: host networking, because the Gateway refuses any bind other than loopback; nothing published; `serve.json` proxying `https :443` to `127.0.0.1:7979` with Funnel off; the same hardening. The image is a plain `node:24` workspace that runs `apps/gateway/src/main.ts` through tsx. Delete this folder once #60 lands, and point `compose.test.ts` at `deploy/`.

## Run it

```bash
cd tests/integration/server-mode
mkdir -p secrets && printf '%s' '<bot token from @BotFather>' > secrets/telegram_bot_token && chmod 600 secrets/telegram_bot_token
cat > .env <<'EOF'
PSYCHE_TELEGRAM_BOT_USERNAME=<your_bot_username>
PSYCHE_PUBLIC_ORIGIN=https://psyche.<tailnet>.ts.net
TS_AUTHKEY=tskey-auth-...        # one-off, pre-approved, tagged tag:psyche
PSYCHE_MODEL=...                 # and the provider key, see apps/gateway/src/compose/models.ts
EOF
docker compose up -d --build
docker compose --profile tailscale up -d
```

`.env` and `secrets/` are git-ignored. The bot token exists only as the Compose secret `/run/secrets/telegram_bot_token`, which `channelsSetupFromEnv` reads through `PSYCHE_TELEGRAM_BOT_TOKEN_FILE`. An empty file disables Telegram.

**Gap:** `main.ts` does not mount the channels part yet. Until the INT-2 composition lands there (`parts: [s => composeChannels(s, channelsSetupFromEnv(process.env, readFile))]`), the container runs the Gateway without Telegram.

## Pair the first admin device

The handshake secret never grants `operator.admin`, so approve the first device on the server:

```bash
docker compose exec gateway node --import tsx apps/gateway/src/main.ts devices list
docker compose exec gateway node --import tsx apps/gateway/src/main.ts devices approve <CODE>
```

Then open `https://psyche.<tailnet>.ts.net` from a tailnet device. It pairs like any other device. Tailscale identity headers are never used for authorization (security §10).

## Telegram

1. From the admin device, run `channels.configure {type: "telegram", account: "<bot username>", ownerIds: ["<your numeric id>"]}`. The adapter attaches as soon as the channel row exists.
2. Message the bot. You get a pairing code, and nothing else happens, because ownership does not grant chat access (security §9).
3. Approve the code with `channels.pairing.approve` (needs `operator.admin`).
4. Ask something. The reply comes back in the chat. Write-class approvals arrive as buttons. Purchases, credential fills, `exec_host`, and policy or pairing changes never do (security §3.7, §9).

## Pair the Mac as a remote node (manual, not automated here)

1. On the Mac, switch the app to remote mode and set the Gateway URL to `https://psyche.<tailnet>.ts.net` (feature N13). The Mac must be on the tailnet.
2. The Mac connects with `role: "node"` and gets a pairing code. On the server, run `devices approve <CODE> node`, or approve it from an admin device with the `node` scope only.
3. Check that it shows up in `nodes.list` with its capabilities (notifications, iMessage, computer use).

**Gap: Touch ID approvals.** Approvals from the server should reach the Mac as notifications with Approve / Deny and `authenticationRequired` for purchases and credential fills (security §3.7). This needs S14's mac helper (PR #47, not merged) and a presence verifier on the broker. The composed broker has no presence verifier today, so a desktop answer to a `purchase` approval is accepted without Touch ID. Telegram is not affected, because purchases never reach chat.

## Tests

`compose.test.ts` validates this file statically in CI: loopback/host networking, no published ports, the secret, the Serve proxy, pinned images, and no inline secrets. The real `docker compose up` run is gated on `PSYCHE_LIVE_TESTS=1` and a working `docker`.
