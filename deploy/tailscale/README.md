# Tailscale Serve in front of the Gateway

Tailnet-only HTTPS for the web UI and remote clients (security §10, "Identity-aware proxies"). The Gateway stays on `127.0.0.1:7979`; Tailscale terminates TLS with a `*.ts.net` certificate and proxies to loopback. Nothing is reachable from the public internet: Funnel is off in `serve.json`.

## With Compose (server)

1. In the Tailscale admin console, create a tag `tag:psyche` and a one-off, pre-approved auth key with that tag. Turn on HTTPS certificates for the tailnet (DNS › HTTPS Certificates).
2. Put it in `deploy/.env` (never commit it):
   ```bash
   TS_AUTHKEY=tskey-auth-…
   TS_HOSTNAME=psyche
   ```
3. Start, then tell the Gateway its public origin (WebSocket `Origin` check) and restart it:
   ```bash
   docker compose -f deploy/docker-compose.yml --profile tailscale up -d
   docker compose -f deploy/docker-compose.yml exec gateway psyche config set gateway.publicOrigin https://psyche.<your-tailnet>.ts.net
   docker compose -f deploy/docker-compose.yml restart gateway
   ```
4. Open `https://psyche.<your-tailnet>.ts.net` from a device on the tailnet. It pairs like any device: approve it with `docker compose -f deploy/docker-compose.yml exec gateway psyched devices approve <CODE>` (first admin) or from an admin device.

`serve.json` maps `https://${TS_CERT_DOMAIN}:443/` to `http://127.0.0.1:7979`. The container runs in userspace networking mode on the host network, so it never touches the host's routing table.

## Without Docker (Mac or Linux host)

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7979
psyche config set gateway.publicOrigin https://<host>.<tailnet>.ts.net
psyche restart
```

## Identity headers and trusted-proxy mode

Tailscale Serve adds `Tailscale-User-Login` / `Tailscale-User-Name` to proxied requests. The Gateway **never** authorizes the API with them: every client still completes the signed device challenge and needs an owner-approved pairing. Trusted-proxy mode only records which proxy may set the headers, so the web UI can later offer passkey login (INT-2):

```bash
psyche config set gateway.trustedProxy.trustedProxies '["127.0.0.1/32"]'
psyche config set gateway.trustedProxy.enabled true
psyche restart
```

`trustedProxies` is required when the mode is on (the Gateway refuses to start without it). Tailscale Serve overwrites client-supplied identity headers, which is what makes the headers trustworthy at all.

`psyche security audit` flags trusted-proxy mode without CIDRs and public ingress without passkeys.
