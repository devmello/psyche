# Install Psyche

Psyche has three parts:

- **The Gateway** (`psyched`): the always-on process that runs your agent. It listens only on `127.0.0.1:7979` and keeps its data in `$PSYCHE_HOME` (default `~/.psyche`, mode 0700).
- **The desktop app** (`Psyche.app` on macOS, `Psyche.exe` on Windows): installs and supervises the Gateway on your computer.
- **The CLI** (`psyche`): setup, status, pairing, backups and upgrades, on macOS, Windows and Linux.

Pick one setup:

- [On your Mac](#on-your-mac): the desktop app runs the Gateway locally.
- [On Windows](#on-windows): the same, for Windows 10 and 11 on x64.
- [On a Linux server with Docker Compose](#on-a-linux-server-with-docker-compose): recommended for servers.
- [On a Linux host without Docker](#on-a-linux-host-without-docker): a systemd user service.

## Requirements

- **Mac:** macOS 15 Sequoia or later, Apple silicon or Intel. Some features need newer macOS: on macOS 15 the command sandbox needs Colima or Docker Desktop; macOS 26 and later can use Apple's `container` instead.
- **Windows:** Windows 10 (1903 or later) or Windows 11, x64. No administrator rights: Psyche installs for your user only.
- **Linux server:** Docker with Compose. There is no other OS requirement.

## On your Mac

### 1. Install the desktop app

The usual way is the DMG. Download it from the [GitHub releases page](https://github.com/devmello/psyche/releases): `Psyche-<version>-arm64.dmg` for Apple silicon, `Psyche-<version>-x64.dmg` for Intel. The app needs nothing else on your Mac: no Node, no pnpm, no source checkout. It carries the Gateway (`psyched`, with its own Node runtime), the `psyche` CLI and Psyche Helper.

**With Homebrew (once the tap is live).** The cask is written but the tap (`devmello/homebrew-psyche`) is not published yet, so use the DMG for now. When it is live:

```bash
brew install --cask devmello/psyche/psyche
```

The cask is marked `auto_updates`: Psyche updates itself in the background, so `brew upgrade` leaves it alone. See [Uninstall](#uninstall-on-your-mac) for `brew uninstall --zap`.

Each DMG has a checksum file next to it (`Psyche-<version>-arm64.dmg.sha256`), and the release also has `SHA256SUMS` for every file. Download one of them into the same folder and check the DMG before you open it:

```bash
shasum -a 256 -c Psyche-<version>-arm64.dmg.sha256
```

or

```bash
shasum -a 256 -c --ignore-missing SHA256SUMS
```

It must print `Psyche-<version>-arm64.dmg: OK` (or `x64`).

Open the DMG and drag Psyche onto the Applications folder next to it.

**Unsigned builds.** Releases are signed and notarized by Apple only when they were built with the project's signing keys. Until the first signed release, the app is signed ad-hoc, and macOS blocks it the first time you open it ("Psyche can't be opened" or "cannot verify that it is free of malware"). Verify the checksum as above first. Then:

1. Open Psyche from Applications and click **Done** on the warning.
2. Open System Settings › Privacy & Security, scroll to Security and click **Open Anyway** next to the Psyche message. Confirm with your password.

On macOS 14 and earlier, right-clicking Psyche in Applications and choosing **Open** does the same. From macOS 15 on, right-click Open no longer skips the check, so use the System Settings button. If you prefer the terminal, this removes the download quarantine instead:

```bash
xattr -dr com.apple.quarantine /Applications/Psyche.app
```

Unsigned builds also lose macOS permissions (Accessibility, Screen Recording, Microphone, Automation) each time you install a new build, because macOS ties those grants to the app's signature. After an upgrade, `psyche doctor` warns about it. The old switches stay visible in System Settings but no longer apply: reset them with `tccutil reset All com.psyche.helper` and grant them again.

### 2. Open Psyche

The first time you open the app, it installs the LaunchAgent `com.psyche.gateway` (pointing at the `psyched` inside the app) and starts the Gateway. It also starts Psyche Helper, which pairs itself with the Gateway, with no code to type. The Gateway keeps running when you close the window. Its logs are in `$PSYCHE_HOME/logs/`.

Psyche asks for no macOS permissions at first launch. Each one is requested when you turn on a feature that needs it (Settings › Permissions lists them all).

If you move Psyche.app after the first launch, open it again from its new place so it rewrites the LaunchAgent.

If the app reports that `psyched` is not bundled, your build does not include the Gateway; install a release build.

### 3. Install the CLI (recommended)

You need the CLI for backups and upgrades. The app already contains one. Put it on your PATH:

```bash
sudo ln -sf /Applications/Psyche.app/Contents/Resources/psyched/psyche /usr/local/bin/psyche
```

It runs on the app's own Node runtime and is updated along with the app. Or install it separately with Homebrew:

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

The first-run checklist checks the install in the order you would fix it:

```bash
psyche doctor --first-run
```

| # | Item | When it is not ok |
| --- | --- | --- |
| 1 | Psyche.app is in /Applications (or ~/Applications) | Drag it there from the DMG |
| 2 | The LaunchAgent is installed and loaded | Open Psyche.app (or `psyche start`) |
| 3 | The LaunchAgent runs a `psyched` that exists | You moved or deleted the app: open it from its new place |
| 4 | The Gateway answers `/healthz` | See the LaunchAgent items, then `$PSYCHE_HOME/logs/` |
| 5 | This CLI is paired | `psyche onboard`, then approve the code (step 4) |
| 6 | Psyche Helper is connected | Open Psyche.app, which starts it |
| 7 | Permissions: the next one to grant | Psyche › Settings › Permissions, or the System Settings link it prints |
| 8 | Helper signing (unsigned builds only) | A warning: permissions are lost on upgrade (see above) |
| 9 | A model provider | `psyche vault add …` (or `psyche onboard`) |
| 10 | The vault is set up and the recovery key confirmed | `psyche onboard` |

It exits 0 when nothing fails. Warnings, such as a permission you have not granted yet, do not fail it unless you add `--strict`. `--json` prints the same items for scripts. The full check, including the sandbox, bind address, disk and file modes:

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

## Uninstall on your Mac

**From the app (recommended).** Open Settings › About › **Uninstall Psyche…**. The sheet lists exactly what will go before you confirm:

- It stops and removes the Gateway LaunchAgent (`com.psyche.gateway`), stops Psyche Helper and turns off "Open at login".
- It moves the app's files outside the bundle to the Trash: `~/Library/Application Support/Psyche`, caches, logs, preferences, saved state and web storage.
- It moves `Psyche.app` to the Trash, then quits.
- **Keep my data** is the default: `~/.psyche` (chats, memory, vault, backups) stays where it is, so installing Psyche again picks up where you left off.
- **Delete my data** also moves the data folder to the Trash. Because it cannot be undone once the Trash is emptied, it asks you to type `DELETE` and to confirm with Touch ID (or the approval card on this Mac), and the card names the exact folder. Back up first with `psyche backup create` if you want a copy. Psyche refuses a folder that is not clearly its own: it must be inside your home folder (never the home folder, `Documents`, `Desktop`, `Downloads`, `Library` or a volume) and hold Psyche's database or `config.json`. If your data lives somewhere else, move it to the Trash from Finder.
- **Keychain items stay** unless you tick "Also remove my Keychain items", which removes exactly `com.psyche.vault`, `com.psyche.helper.items`, `com.psyche.helper.identity` and `com.psyche.helper.probe`. Without your data they are useless; you can also remove them in Keychain Access.
- If the Gateway agent belongs to another copy of Psyche or to the `psyche` CLI, it is left alone and the sheet says so.
- Before it stops anything, Psyche checks that every item can be moved to the Trash (a read-only folder, another volume, or an app running from a temporary location is refused with the manual step), shows a confirmation dialog, and clears any downloaded update so it cannot reinstall the app. If a step still fails, Psyche stays open, starts the Gateway again, and lists what to finish by hand.

Nothing is deleted outright: everything goes to the Trash, so you can put it back until you empty it. The sheet is only offered by a packaged Psyche that runs its own Gateway agent on this Mac, never from a window connected to another computer or from a development build, and the agent cannot start it.

**With Homebrew.** Once the tap is live:

```bash
brew uninstall --cask psyche          # stops the agent and removes the app, keeps your data
brew uninstall --cask --zap psyche    # also moves the app's files outside the bundle to the Trash
```

Neither command deletes `~/.psyche`: the `psyche` CLI shares it. To delete it too, back it up (`psyche backup create`) and move the folder to the Trash yourself. Both commands also stop a Gateway that the `psyche` CLI installed, because it uses the same `com.psyche.gateway` LaunchAgent label.

**If the app won't launch.** Do the same steps by hand:

```bash
launchctl bootout "gui/$(id -u)/com.psyche.gateway"
osascript -e 'tell application "Psyche" to quit'
pkill -f PsycheHelper.app
rm -f ~/Library/LaunchAgents/com.psyche.gateway.plist
```

Then drag `/Applications/Psyche.app` to the Trash. To remove the rest, move these to the Trash too (skip `~/.psyche` to keep your data):

```
~/Library/Application Support/Psyche
~/Library/Application Support/com.psyche.helper
~/Library/Caches/com.psyche.desktop
~/Library/Caches/com.psyche.helper
~/Library/Caches/Psyche
~/Library/HTTPStorages/com.psyche.desktop
~/Library/Logs/Psyche
~/Library/Preferences/com.psyche.desktop.plist
~/Library/Preferences/com.psyche.helper.plist
~/Library/Saved Application State/com.psyche.desktop.savedState
~/Library/Saved Application State/com.psyche.helper.savedState
~/Library/WebKit/com.psyche.desktop
~/.psyche   (your data: skip it to keep it)
```

The vault and helper also keep items in your Keychain (`com.psyche.vault`, `com.psyche.helper.*`); without `~/.psyche` they are useless, and you can remove them in Keychain Access. To clear Psyche's privacy grants, run `tccutil reset All com.psyche.desktop` and `tccutil reset All com.psyche.helper`.

**Building from source.** `pnpm app:install` (from a checkout) keeps your data by default. `pnpm app:install --reset` is the explicit wipe: it prints everything it will delete and asks you to type `RESET`. It uses the data folder from the installed LaunchAgent (warning if `PSYCHE_HOME` differs), refuses anything that is not a Psyche folder strictly inside your home folder, and refuses `--yes` unless the folder is the default `~/.psyche`. A path it cannot remove is reported at the end; the rest still goes.

## On Windows

### 1. Install the desktop app

There is no signed Windows release yet: build the installer from a source checkout (see [getting-started.md](getting-started.md#on-windows) for the tools), then run it:

```powershell
pnpm app:build
```

```powershell
pnpm app:install
```

`pnpm app:build` writes `dist\Psyche-<version>-Setup.exe` (and a portable `dist\Psyche-<version>-win32-x64.zip`). `pnpm app:install` runs the installer silently. Like the Mac script, it **keeps your data** by default: it quits Psyche, ends the Gateway task so nothing runs from the old install, installs, and opens the new build, which registers the task again. `--keep-data` is accepted and does nothing.

`pnpm app:install --reset` is the explicit wipe, for a from-scratch first run. It prints everything it will delete (permanently, not to the Recycle Bin) and asks you to type `RESET`:

```powershell
pnpm app:install --reset
```

- It deletes the data folder (`%USERPROFILE%\.psyche`), `%APPDATA%\Psyche`, the helper's and Gateway's folders (`%APPDATA%\com.psyche.helper`, `%LOCALAPPDATA%\com.psyche.helper`, `%LOCALAPPDATA%\Psyche Helper`, `%LOCALAPPDATA%\com.psyche.gateway`), the sandbox PC's guest image (`%LOCALAPPDATA%\Psyche\vm-images`), the Gateway scheduled task and the Credential Manager items whose name starts with `Psyche/`. It lists only what exists.
- It uses the data folder from the installed Gateway task (warning if `PSYCHE_HOME` differs), refuses anything that is not a Psyche folder strictly inside your user folder (never the user folder, a drive, a network share, `Documents`, `Desktop`, `Downloads`, `AppData`, `OneDrive` and the like, or a path that goes through a link), and refuses `--yes` unless the folder is the default `%USERPROFILE%\.psyche`.
- Without a terminal it refuses unless you pass `--yes`, which skips the question. A path it cannot remove is reported at the end; the rest still goes.
- It does not remove the sandbox PC service, which needs an administrator; see [Uninstall on Windows](#uninstall-on-windows).

You can also double-click `Psyche-<version>-Setup.exe`. It installs Psyche for your Windows user into `%LOCALAPPDATA%\Psyche` without asking for administrator rights, adds Psyche to the Start menu and the desktop, and opens it. The app carries the Gateway (`psyched`, with its own Node runtime), the `psyche` CLI and Psyche Helper; nothing else needs to be installed.

**Unsigned builds.** A build without the project's code-signing certificate is unsigned. When you open its installer, Microsoft Defender SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**. Signed releases do not show this once the certificate has built up reputation.

### 2. Open Psyche

Open Psyche from the Start menu. The Gateway runs as a scheduled task for your user, `\Psyche\Gateway-<your SID>` (for example `\Psyche\Gateway-S-1-5-21-…-1001`; each Windows account that installs Psyche has its own), started when you sign in to Windows; it keeps running when you close the window. An install of an earlier version used `\Psyche\Gateway` for everyone; the app replaces that task with yours the first time it starts, when the old one is yours. Its logs are in `%USERPROFILE%\.psyche\logs\` (`gateway.out.log`, `gateway.err.log`). Task Scheduler shows the task under **Task Scheduler Library › Psyche**.

To start it from the CLI instead, point `psyche start` at the `psyched.cmd` inside the install (the CLI also finds it on its own):

```powershell
psyche start --psyched "$env:LOCALAPPDATA\Psyche\app-<version>\resources\psyched\psyched.cmd"
```

`psyche stop`, `psyche restart` and `psyche status` work on the task the same way.

### 3. Updates and uninstalling

Psyche checks for updates when it starts, verifies them against the signed update manifest and installs them in the background; the new version opens the next time you start Psyche. Updates are off in builds without a signature or a release key.

To uninstall, see [Uninstall on Windows](#uninstall-on-windows).

## Uninstall on Windows

**From the app (recommended).** Open Settings › About › **Uninstall Psyche…**. The sheet lists exactly what will go before you confirm:

- It stops and deletes your Gateway scheduled task (`\Psyche\Gateway-<your SID>`, and this account's `\Psyche\Gateway` of an earlier version), stops Psyche Helper, turns off "Open at login" and removes the `psyche://` and `psyche-pair:` link handlers and the helper's notification keys.
- It moves the app's files outside the install folder to the Recycle Bin: `%APPDATA%\Psyche` (settings, web storage, caches, logs), the helper's and Gateway's folders and the sandbox PC's guest image. Chromium keeps `%APPDATA%\Psyche` open while Psyche runs, so that folder is moved right after Psyche quits.
- It removes the app with Squirrel's own uninstaller (`Update.exe --uninstall`, the same as Settings › Apps), then quits. That removes `%LOCALAPPDATA%\Psyche`, the shortcuts and the Programs and Features entry; it does not use the Recycle Bin, and installing Psyche again brings the app back.
- **Keep my data** is the default: `%USERPROFILE%\.psyche` (chats, memory, vault, backups) stays where it is, so installing Psyche again picks up where you left off.
- **Delete my data** also moves the data folder to the Recycle Bin. Because it cannot be undone once the bin is emptied, it asks you to type `DELETE` and to confirm with Windows Hello (or the approval card on this PC), and the card names the exact folder. Back up first with `psyche backup create` if you want a copy. Psyche refuses a folder that is not clearly its own: it must be inside your user folder (never the user folder itself, `Documents`, `Desktop`, `Downloads`, `AppData`, `OneDrive`, a drive or a network share) and hold Psyche's database or `config.json`. If your data lives somewhere else, move it to the Recycle Bin from File Explorer.
- **Credential Manager items stay** unless you tick "Also remove my Credential Manager items", which removes exactly the generic credentials whose name starts with `Psyche/` (the vault key and the helper's items, including their `#2`, `#3` parts), listed one by one. Without your data they are useless; you can also remove them in Credential Manager (Control Panel › Credential Manager › Windows Credentials).
- **The sandbox PC service** (`PsycheVM-<your SID>`), when you set the sandbox PC up, is registered with Windows and removing it needs an administrator: Windows shows one prompt. If you dismiss it or your account cannot elevate, Psyche carries on and shows these steps (also saved to `%TEMP%\Psyche-remove-sandbox-pc.txt`); open Windows Terminal as an administrator and run `sc.exe stop PsycheVM-<your SID>` then `sc.exe delete PsycheVM-<your SID>`.
- If the Gateway task runs another copy of Psyche or the `psyche` CLI (its runtime is not inside this install folder), it is left alone and the sheet says so.
- Before it stops anything, Psyche checks that every item can be moved to the Recycle Bin (a read-only folder or a network location is refused with the manual step), shows a confirmation dialog, and stops the updater so nothing can reinstall the app. If the Gateway will not stop or a step fails, Psyche stays open, starts the Gateway again and lists what to finish by hand.

Nothing is deleted outright except the app itself: your files go to the Recycle Bin, so you can put them back until you empty it. The sheet is only offered by a packaged, Squirrel-installed Psyche that runs its own Gateway task on this PC, never from a window connected to another computer or from a development build, and the Gateway cannot start it.

**From Settings › Apps.** Open **Settings › Apps › Installed apps**, find Psyche and choose **Uninstall**. That removes the app, its shortcuts, your Gateway task (unless it runs another copy), the sandbox PC service (one administrator prompt, or the manual steps in `%TEMP%\Psyche-remove-sandbox-pc.txt`), the **Open at login** entry and the `psyche://` link handler. It leaves your data (`%USERPROFILE%\.psyche`), `%APPDATA%\Psyche` and the Credential Manager items alone; use the app's sheet above, or remove them by hand.

**If the app won't launch.** Do the same steps by hand in PowerShell, then move the folders to the Recycle Bin in File Explorer (skip `%USERPROFILE%\.psyche` to keep your data):

```powershell
schtasks /End /TN "\Psyche\Gateway-<your SID>"
schtasks /Delete /TN "\Psyche\Gateway-<your SID>" /F
Stop-Process -Name Psyche, psyche-helper -Force -ErrorAction SilentlyContinue
& "$env:LOCALAPPDATA\Psyche\Update.exe" --uninstall
```

```
%APPDATA%\Psyche
%APPDATA%\com.psyche.helper
%LOCALAPPDATA%\com.psyche.helper
%LOCALAPPDATA%\Psyche Helper
%LOCALAPPDATA%\com.psyche.gateway
%LOCALAPPDATA%\Psyche\vm-images   (the sandbox PC's guest image)
%USERPROFILE%\.psyche   (your data: skip it to keep it)
```

Your SID is the last column of `whoami /user`. To remove the credentials, run `cmdkey /list` and `cmdkey /delete:Psyche/<name>` for each target that starts with `Psyche/`.

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

Open `deploy/.env` and set `PSYCHE_IMAGE` to the image and digest from the release notes, for example `PSYCHE_IMAGE=ghcr.io/devmello/psyche-gateway:v0.1.0@sha256:...`. Without it, Compose builds the image from your checkout instead of pulling one. Alternatively, download `psyche-compose-<version>.tar.gz` from the release: its `docker-compose.yml` already defaults to that release's image by digest. Never commit `deploy/.env`.

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

Each release has `psyche` binaries: `psyche-darwin-arm64`, `psyche-darwin-x64`, `psyche-linux-x64` and `psyche-linux-arm64`, plus `SHA256SUMS`. On Windows the CLI comes with the desktop app: `psyche.cmd` sits next to `psyched.cmd` in `%LOCALAPPDATA%\Psyche\app-<version>\resources\psyched\`.

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
