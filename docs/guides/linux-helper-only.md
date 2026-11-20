# Let Psyche use a Linux computer (helper only)

Install the Psyche helper on a Linux computer and your Mac's Psyche can use it: open apps on a private screen there, and (within limits you set on that computer) run commands and read or write files. The Mac stays the brain. The Linux computer stores nothing of Psyche's, and it dials out to your Gateway, so nothing listens on it.

Design and decisions: [linux-helper-only-2026.md](../design/linux-helper-only-2026.md). This page is the install, update and removal. To pair, see the Settings steps in [remote-gateway.md](remote-gateway.md) for how the Mac side is reached (Tailscale or your network).

## Before you start

- A Linux computer with **systemd** running (Ubuntu, Debian, Fedora and the like; x86_64 or aarch64). On WSL, turn systemd on first (`[boot]` `systemd=true` in `/etc/wsl.conf`).
- Your Mac's Gateway reachable from it, over Tailscale or the local network.
- Programs the helper uses: `xvfb`, `dbus-user-session` (Debian) or `dbus` (Fedora), `at-spi2-core`, `xauth` and `bubblewrap`. The deb and rpm pull them in. With the tarball, install them yourself.

## Choose how it runs

| | Your own account (default) | A separate account |
| --- | --- | --- |
| What Psyche can reach | Your files, apps and logins on that computer, as you can | Only that account's files and apps |
| Program and service file | In your home (`~/.local/lib/psyche-helper`, `~/.config/systemd/user`) | Root's: `/usr/local/lib/psyche-helper` and `/etc/systemd/user` |
| Limits (`policy.json`) | In your config folder. Your account can edit them, so Settings flags them as changeable. `--root-policy` moves the file to `/etc`, but the program still lives in your home, so Settings keeps the warning | In `/etc/psyche-helper/policy.json`, owned by root. The account can change none of the file, the program or the service file |
| Set up with | `./install.sh` | `sudo ./install.sh --dedicated-user` |

The helper never gets root either way: its service runs with `NoNewPrivileges`, so nothing it starts can use `sudo`, `pkexec` or a setuid program. If your account has passwordless `sudo`, other programs you run as that account still can, which is why the separate account exists.

## Install

### Tarball (any distribution)

```bash
tar --zstd -xf psyche-helper-<version>-linux-x64.tar.zst     # or -linux-arm64
cd psyche-helper-<version>-linux-x64
./install.sh                          # your own account
# or:  sudo ./install.sh --dedicated-user          (account "psyche-helper")
# or:  sudo ./install.sh --dedicated-user lab-psyche
```

At a terminal, `install.sh` asks once which account to use. Options:

| Option | Meaning |
| --- | --- |
| `--dedicated-user [NAME]` | Create a no-password, no-shell account and run the helper as it. Refuses an account that is not a Psyche helper account |
| `--ceiling default\|narrow` | The limits written on first install. `default`: its own screen, contained commands, files under `~`. `narrow`: apps only, no commands and no files |
| `--root-policy` | Keep the limits in `/etc/psyche-helper/policy.json` (one `sudo` write). On an own-account install the program stays in your home, which your account can change, so Settings still shows the limits as changeable; for a limit your account cannot change, use a separate account or the deb/rpm |
| `--no-linger` | Do not turn on linger |
| `--uninstall [--purge]` | Remove the helper. `--purge` also removes its settings, and a dedicated account |

For your own account the installer puts the helper in `~/.local/lib/psyche-helper/` (a link in `~/.local/bin`) and the service in `~/.config/systemd/user/`, creating only folders that are missing (private, 0700) and leaving the ones you have as they are. For a separate account, root installs the program and the service file in root-owned places and everything under that account's home is written by that account itself, never by root. Either way it enables the service. Re-running it is safe and keeps limits you already have.

### deb or rpm

```bash
sudo apt install ./psyche-helper-<version>-linux-x64.deb      # Debian, Ubuntu
sudo dnf install ./psyche-helper-<version>-linux-x64.rpm      # Fedora
psyche-helper-setup                                            # as the account that should run it
# or:  sudo psyche-helper-setup --dedicated-user
```

The package installs the program under `/usr/lib/psyche-helper`, the service under `/usr/lib/systemd/user`, and the limits at `/etc/psyche-helper/policy.json`, owned by root. A package install is the stronger setup: neither your account nor anything the helper runs can change the limits, the program or the service file. (An account can still put a service file of its own in its own home; the helper notices that it is not running from the packaged file and Settings then shows the limits as changeable.) `psyche-helper-setup` only turns the service on for one account and sets up linger.

### Linger: the one step that needs an administrator

The helper has to run with nobody logged in. Linger lets one account's service manager start at boot. The installer runs `loginctl enable-linger <account>` and tells you why. If your system asks for an administrator, it asks for `sudo` at a terminal. Otherwise it prints the exact command to run. Without linger the helper runs only while that account is logged in.

## Pair it

1. On the Mac: Settings → Devices → **Computers Psyche can use** → **Add a Linux computer**. Choose Tailscale or this network. It shows a one-time link, `psyche-machine:v1:…`.
2. On the Linux computer, as the helper's account (the installer prints the exact command, which for a separate account looks like `sudo -u psyche-helper -H env XDG_RUNTIME_DIR=/run/user/<uid> …`):

   ```bash
   psyche-helper pair -          # paste the link; nothing is echoed
   systemctl --user start psyche-helper-remote.service
   psyche-helper status
   ```

3. Without a link: `psyche-helper pair wss://<gateway>` shows the Gateway's fingerprint and a code; approve it on the Mac.

A service that is not paired yet stops with status 78 and is not restarted in a loop. After `pair`, start it.

## Update

The own-account tarball install updates itself (run it as that account, never as root: `update` refuses root):

```bash
psyche-helper update --check      # look only
psyche-helper update              # fetch, verify, install, restart the service
psyche-helper update --rollback   # go back to the previous helper
```

What `update` checks before it replaces anything, the same way the Mac app checks its updates:

1. The release manifest's Ed25519 signature, against the release keys built into the helper (the same keys as the Mac app).
2. That every file is under `https://github.com/devmello/psyche/releases/download/`, over https. Redirects may only go to GitHub's own hosts.
3. No downgrade and no reinstall: only a newer version is installed.
4. The tarball's size and SHA-256 against the manifest.
5. That the unpacked program reports the release's version.

Anything else is refused and nothing changes. The old program stays next to the new one as `psyche-helper.prev`. If the service does not stay up after the restart, `update` puts the old one back and says so; `--rollback` does the same by hand.

For a machine with no route to GitHub: download `update-manifest.json`, `update-manifest.json.sig` and the tarball of one release into a folder and run `psyche-helper update --from <folder>`. The same checks apply.

A deb or rpm install is updated with the package manager (`apt`, `dnf`); a separate account's root-owned program is updated by unpacking the new tarball and running `sudo ./install.sh --dedicated-user` again. `psyche-helper update` says so and does nothing. The installer's service file is not changed by `update`: after a release that changes it, run the new tarball's `install.sh` again.

## Remove

```bash
./install.sh --uninstall                       # your own account: removes the helper, keeps settings
./install.sh --uninstall --purge               # also its settings and key
sudo ./install.sh --dedicated-user --uninstall --purge     # removes the separate account too
sudo apt remove psyche-helper                  # deb: remove; purge also deletes /etc/psyche-helper/policy.json
```

Remove the computer in Psyche too (Settings → Devices → Computers Psyche can use → Remove), or run `psyche-helper unpair` first.

## Troubleshooting

- `systemctl --user status psyche-helper-remote.service` and `journalctl --user -u psyche-helper-remote.service` show what it is doing. Status 78 means: not paired, or revoked, or the identity changed. Run `psyche-helper pair` again.
- "no service manager": the account has no user systemd. Turn on linger and run the installer again.
- `psyche-helper status` shows the limits in effect. A limits file the helper cannot read, or one with the wrong owner, denies everything.

## For the release job

`deploy/linux-helper/build-packages.sh` builds the three packages from one built binary; `.github/workflows/release.yml` runs it in the `helper-packages` job and `deploy/scripts/update-manifest.mjs build --helper-complete` adds them to the signed manifest. `deploy/linux-helper/test/vm-test.sh` checks the whole thing (packages, both account modes, linger, update, tampering and rollback) on a throwaway Linux VM with systemd. It creates and removes accounts, so never run it on a computer you use.
