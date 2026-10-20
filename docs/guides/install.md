# Install Psyche

Psyche has three parts:

- **The Gateway** (`psyched`): the always-on process that runs your agent. It listens only on `127.0.0.1:7979` and keeps its data in `$PSYCHE_HOME` (default `~/.psyche`, mode 0700).
- **The desktop app** (`Psyche.app`, macOS only): installs and supervises the Gateway on your Mac.
- **The CLI** (`psyche`): setup, status, pairing, backups and upgrades, on macOS and Linux.

Pick one setup:

- [On your Mac](#on-your-mac): the desktop app runs the Gateway locally.
- [On a Linux server with Docker Compose](#on-a-linux-server-with-docker-compose): recommended for servers.
- [On a Linux host without Docker](#on-a-linux-host-without-docker): a systemd user service.

## Requirements

- **Mac:** macOS 15 Sequoia or later, Apple silicon or Intel. Some features need newer macOS: on macOS 15 the command sandbox needs Colima or Docker Desktop; macOS 26 and later can use Apple's `container` instead.
- **Linux server:** Docker with Compose. There is no other OS requirement.

## On your Mac

### 1. Install the desktop app

With Homebrew:

```bash
brew install --cask devmello/psyche/psyche
```

Or download it from the [GitHub releases page](https://github.com/devmello/psyche/releases): `Psyche-<version>-arm64.dmg` for Apple silicon, `Psyche-<version>-x64.dmg` for Intel. Download `SHA256SUMS` from the same release into the same folder and check the DMG before you open it:

```bash
shasum -a 256 -c --ignore-missing SHA256SUMS
```

It must print `Psyche-<version>-arm64.dmg: OK` (or `x64`).

Open the DMG and drag Psyche to Applications.

**Unsigned builds.** Releases are signed and notarized by Apple only when they were built with the project's signing keys. Until the first signed release, the app is unsigned and macOS blocks it the first time you open it. Verify the checksum as above first. Then open Psyche once, go to System Settings › Privacy & Security, and click **Open Anyway**. On older setups, right-click Psyche in Applications and choose Open. If you prefer the terminal, this removes the download quarantine instead:

```bash
xattr -dr com.apple.quarantine /Applications/Psyche.app
```

Unsigned builds also lose macOS permissions (Accessibility, Screen Recording, Microphone, Automation) each time you install a new build, because macOS ties those grants to the app's signature. You grant them again in System Settings after each upgrade.

### 2. Open Psyche

The first time you open the app, it installs the LaunchAgent `com.psyche.gateway` and starts the Gateway. The Gateway keeps running when you close the window. Its logs are in `$PSYCHE_HOME/logs/`.

If the app reports that `psyched` is not bundled, your build does not include the Gateway; install a release build.

### 3. Install the CLI (recommended)

You need the CLI for backups and upgrades.

```bash
brew install devmello/psyche/psyche-cli
```

Without Homebrew, see [Install the CLI from a release](#install-the-cli-from-a-release).

### 4. Pair the CLI and finish setup

`psyche onboard` creates `$PSYCHE_HOME`, pairs the CLI, stores one model API key in the vault, and writes your agent's name and yours.

```bash
psyche onboard
```

The first time, it prints a pairing code and waits. Approve the code on the same Mac with the `psyched` inside the app bundle:

```bash
/Applications/Psyche.app/Contents/Resources/psyched/psyched devices approve <CODE>
```

The first device you approve this way becomes the admin. Later devices can be approved from an admin device with `psyche pairing approve <CODE>`.

### 5. Check the install

```bash
psyche doctor
```

```bash
psyche security audit
```

To stop the Gateway completely (it stays stopped until you start it again):

```bash
psyche stop
```

To start it again, point `psyche start` at the `psyched` in the app bundle (or set `PSYCHE_GATEWAY_BIN` to that path):

```bash
psyche start --psyched /Applications/Psyche.app/Contents/Resources/psyched/psyched
```

## On a Linux server with Docker Compose

The Gateway image is `ghcr.io/devmello/psyche-gateway`, built for amd64 and arm64 and signed with cosign.

### 1. Get the deployment files

```bash
git clone https://github.com/devmello/psyche && cd psyche
```

```bash
cp deploy/env.example deploy/.env
```

### 2. Pin and verify the image

Open `deploy/.env` and set `PSYCHE_IMAGE` to the image and digest from the release notes, for example `PSYCHE_IMAGE=ghcr.io/devmello/psyche-gateway:v0.1.0@sha256:...`. Without it, Compose uses the `latest` tag, which you should not run in production. Never commit `deploy/.env`.

Check the signature of that digest (needs [cosign](https://github.com/sigstore/cosign)):

```bash
cosign verify ghcr.io/devmello/psyche-gateway@sha256:<digest> \
  --certificate-identity-regexp '^https://github.com/devmello/psyche/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### 3. Start the Gateway

```bash
docker compose -f deploy/docker-compose.yml up -d --wait
```

```bash
docker compose -f deploy/docker-compose.yml exec gateway psyche status
```

The container uses host networking and listens on the host's `127.0.0.1:7979` only. No port is published. Your data is in the `psyche-home` volume.

### 4. Reach it from your laptop

Pick one:

- **SSH tunnel** (no setup on the server). On your laptop, run the command below, then use `http://127.0.0.1:7979`.

  ```bash
  ssh -L 7979:127.0.0.1:7979 server
  ```

- **Tailscale Serve** (tailnet-only HTTPS): follow [deploy/tailscale/README.md](../../deploy/tailscale/README.md).
- **Cloudflare Tunnel + Access** (a public hostname behind Cloudflare login): follow [deploy/cloudflare/README.md](../../deploy/cloudflare/README.md).

Never open port 7979 to the internet.

### 5. Pair your first device

Install the CLI on your laptop ([below](#install-the-cli-from-a-release), or `brew install devmello/psyche/psyche-cli`). With the tunnel open, run onboarding:

```bash
psyche onboard
```

It prints a pairing code. Approve it on the server; this makes your first admin device:

```bash
docker compose -f deploy/docker-compose.yml exec gateway psyched devices approve <CODE>
```

Then check the server:

```bash
docker compose -f deploy/docker-compose.yml exec gateway psyche doctor
```

```bash
psyche security audit
```

To use the desktop app on your Mac against this server instead of a local Gateway, start it with `PSYCHE_GATEWAY_MODE=external` while the tunnel is open, and approve its pairing on the server the same way.

## On a Linux host without Docker

This runs the Gateway as a systemd user service. It needs a `psyched` executable on the host; the GitHub releases publish the `psyche` CLI but not a standalone `psyched`, so prefer Docker Compose unless you already have one.

```bash
psyche start --psyched /usr/local/bin/psyched
```

Keep it running after you log out:

```bash
loginctl enable-linger "$USER"
```

```bash
psyche logs -f
```

Then pair and check as in steps 4 and 5 of the Mac section, approving the code with `psyched devices approve <CODE>` on the host. For remote access, use an SSH tunnel, `tailscale serve`, or `cloudflared` as above.

## Install the CLI from a release

Each release has `psyche` binaries: `psyche-darwin-arm64`, `psyche-darwin-x64`, `psyche-linux-x64` and `psyche-linux-arm64`, plus `SHA256SUMS`.

1. Download your binary and `SHA256SUMS` from the [releases page](https://github.com/devmello/psyche/releases) into one folder.
2. Check the hash. On macOS:

   ```bash
   shasum -a 256 -c --ignore-missing SHA256SUMS
   ```

   On Linux:

   ```bash
   sha256sum -c --ignore-missing SHA256SUMS
   ```

   Continue only if your file shows `OK`.
3. Install it as `psyche` (use your file name):

   ```bash
   sudo install -m 0755 psyche-linux-x64 /usr/local/bin/psyche
   ```

4. Check it:

   ```bash
   psyche version
   ```

The CLI talks to `http://127.0.0.1:7979` by default. Use `--url` or `PSYCHE_URL` for another address; it refuses plain `http` to a non-loopback host unless you pass `--insecure`.

## Next steps

- Set up backups: [backup-restore.md](backup-restore.md). Write down the vault **recovery key** when Psyche shows it; you need it to restore on another machine.
- Before your first upgrade, read [upgrade.md](upgrade.md).
