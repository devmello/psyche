# Cloudflare Tunnel + Access in front of the Gateway

Public HTTPS hostname without an open inbound port: `cloudflared` makes an outbound connection to Cloudflare and forwards to the loopback Gateway; Cloudflare Access decides who may reach the hostname (security §10). Prefer Tailscale (`deploy/tailscale/`) when every client can join a tailnet; use this when you need a browser-reachable hostname.

## Setup

1. **Tunnel.** Cloudflare dashboard › Zero Trust › Networks › Tunnels › Create a tunnel (cloudflared). Copy the connector token. Add a public hostname, e.g. `psyche.example.com`, with service `http://127.0.0.1:7979`.
2. **Access application.** Zero Trust › Access › Applications › Add › Self-hosted, for `psyche.example.com`. Policy: allow only your identity (email or IdP group). Session duration: 24 h or less. Under the application's settings, note the **Application Audience (AUD) tag** and your team domain (`<team>.cloudflareaccess.com`).
3. **Compose.** Put `CLOUDFLARE_TUNNEL_TOKEN=eyJ…` in `deploy/.env` (never commit it), then:
   ```bash
   docker compose -f deploy/docker-compose.yml --profile cloudflare up -d
   docker compose -f deploy/docker-compose.yml exec gateway psyche config set gateway.publicOrigin https://psyche.example.com
   docker compose -f deploy/docker-compose.yml restart gateway
   ```
4. **Pair.** Open `https://psyche.example.com`, pass Access, and approve the browser as a device: `docker compose -f deploy/docker-compose.yml exec gateway psyched devices approve <CODE>`.

Without Docker: `cloudflared tunnel run --token <token>` on the Gateway host (or `cloudflared service install <token>`).

## What Access does and does not do

- Access keeps strangers from reaching the Gateway at all. It does **not** authorize the API: the Gateway never trusts `Cf-Access-Authenticated-User-Email` or the presence of `Cf-Access-Jwt-Assertion`. Every client still completes the device challenge and needs an owner-approved pairing.
- When trusted-proxy mode verifies Access JWTs (INT-2), it checks the signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and the `aud` claim, never mere presence (OpenClaw only checked presence). Until then the JWT is ignored.
- A public hostname is "public ingress": security §10 requires passkeys and `gateway.allowPublicIngress: true` once those land. `psyche security audit` flags public ingress without passkeys.
- Turn off "Allow all origins"-style CORS settings; the Gateway validates `Origin` itself and only accepts its own origin plus `gateway.publicOrigin` / `gateway.allowedOrigins`.
