---
title: Server mode
---

# Server mode

"Server mode" means the Gateway runs without the Mac app supervising it: under Docker Compose, systemd or launchd, on a Linux server or a Mac without a screen. Clients connect to it from elsewhere and pair as devices.

## Choose how it runs

- **Docker Compose on Linux** (recommended): [Docker and Compose](/get-started/docker).
- **systemd user service on Linux**, or **launchd on a Mac**: `psyche start` installs and starts the service for your user. See the [server mode guide](/guides/server-mode#systemd-and-launchd).

## Reach it safely

The Gateway binds to loopback. To use it from another machine, pick one:

- **SSH tunnel**: nothing to set up on the server.
- **Tailscale Serve**: HTTPS inside your tailnet only.
- **Cloudflare Tunnel and Access**: a public hostname behind Cloudflare login. The Gateway verifies the Access token itself.

Never expose port 7979 directly. A non-loopback bind needs explicit configuration and a token, or the Gateway refuses to start. `psyche security audit` flags risky bind and proxy settings.

## Pair your devices

The first admin device is approved on the server itself (`psyched devices approve <CODE>`). Later devices are approved from a device that already has the admin scope. You choose each device's scopes; a device never declares its own. See [Pairing clients with a server](/guides/server-mode#pairing-clients-with-a-server).

## Use the Mac app with a server

Start the Mac app with `PSYCHE_GATEWAY_MODE=external` while your tunnel is open, and approve its pairing on the server. The Psyche Helper on that Mac connects as a node, so computer use and dictation work against the remote Gateway.

## Learn more

- [Server mode guide](/guides/server-mode)
- [Security: the control plane](https://github.com/devmello/psyche/blob/main/docs/05-security-and-permissions.md#10-control-plane-and-remote-access)
- [Backup and restore](/guides/backup-restore)
