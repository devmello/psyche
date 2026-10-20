---
title: Docker and Compose
---

# Docker and Compose

On a Linux server, run the Gateway from the published image with Docker Compose. The container listens on the host's `127.0.0.1:7979` only and publishes no port. You reach it through an SSH tunnel, Tailscale Serve or Cloudflare Access, never an open port.

## Run it

1. Get the deployment files and copy the example environment:

   ```bash
   git clone https://github.com/devmello/psyche && cd psyche
   ```

   ```bash
   cp deploy/env.example deploy/.env
   ```

2. Pin the image. In `deploy/.env`, set `PSYCHE_IMAGE` to the image and digest from the release notes. Or use the `psyche-compose-<version>.tar.gz` from the release, whose Compose file already pins the digest. You can verify the image signature with cosign: see the [install guide](/guides/install).
3. Start it:

   ```bash
   docker compose -f deploy/docker-compose.yml up -d --wait
   ```

4. Reach it from your laptop. The simplest way is an SSH tunnel:

   ```bash
   ssh -L 7979:127.0.0.1:7979 server
   ```

5. Pair your first device. Run `psyche onboard` on your laptop, then approve the printed code on the server:

   ```bash
   docker compose -f deploy/docker-compose.yml exec gateway psyched devices approve <CODE>
   ```

## What the container does for you

- Runs as a non-root user with a read-only root filesystem and all capabilities dropped.
- Refuses to start on a non-loopback bind without a token file of at least 32 characters (`PSYCHE_GATEWAY_TOKEN_FILE`).
- Keeps all data in the `psyche-home` volume. [Back it up](/guides/backup-restore).

## Limits today

- Mac-only features (computer use, dictation, Messages, VM mode) need a Mac running the Psyche Helper, connected to this Gateway as a node.
- The Playwright browser sidecar in the sample Compose file is optional. Without it, the agent browser features that need a real browser are off.

## Learn more

- [Server mode](/get-started/server-mode): systemd, launchd, Tailscale, Cloudflare
- [Server mode guide](/guides/server-mode): every option in detail
- [deploy/](https://github.com/devmello/psyche/tree/main/deploy): the Dockerfile and Compose files
