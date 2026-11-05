# Linux desktop app (2026)

Status: accepted 2026-11-05 (#1271). **Development is paused on the Mac and continues on a Windows machine; see §0 for where each PR stands and how to resume.** The design itself changes no code. It reverses the "No Linux desktop support" scope line in [cross-platform-2026.md](cross-platform-2026.md), which is updated in the same PR, and replaces the Linux bullet in §5 of [updates-and-install-2026.md](updates-and-install-2026.md).

The owner decided on 2026-11-05 to ship a **full Linux desktop app**. This doc decides how: packaging, updates, a Linux helper, three computer-use modes, presence by password, and the other platform services. It ends with a numbered PR plan that builders can run in parallel, a test plan for a real Linux machine, and the decisions left to the owner.

**The owner's decisions this doc works from**
- A full desktop app, with the same Gateway, web UI and approvals as on the Mac.
- Three computer-use modes: **Direct** (the owner's own desktop), **Virtual screen** (an invisible second display on the owner's machine, using the owner's real files) and **Separate desktop** (a container or VM that can't touch the owner's real apps).
- **No biometrics on Linux.** Presence, the confirmation that risky approvals need (Touch ID on the Mac), is the owner's **password, through polkit**, on by default.
- Lower RAM matters more than disk, so idle cost must be near zero. No paid services or relays. Everything local. Linux needs no signing authority: AppImage, deb and rpm, with Psyche's own Ed25519 release key for updates.

**The recommendation in eight lines**
1. Ship **deb and rpm** (first class on Debian/Ubuntu and Fedora/openSUSE) and an **AppImage** (portable, for everything else), all from electron-forge. No Flatpak or Snap: their sandboxes block the things Psyche is for (§2.1).
2. Data stays in **`~/.psyche`**, the same layout as macOS and Docker. App-level files follow XDG (§2.2).
3. The Gateway runs as a **`systemd --user` unit**. The desktop's supervisor becomes an interface with a launchd and a systemd implementation (§2.3).
4. Updates use the **existing Ed25519 manifest, pre-update snapshot and rollback**. The AppImage replaces itself. deb and rpm download the verified package and install it through the system's admin prompt. No apt or dnf repo in v1 (§3).
5. A new **Linux helper in Rust** (`apps/linux-helper`) speaks the same node protocol as the Mac helper, so the Gateway sees "a helper". It starts on demand and exits when idle, so it costs nothing at rest (§4).
6. **Direct** uses AT-SPI2 for the structure tree, plus the ScreenCast and RemoteDesktop portals on Wayland (approved once, with a restore token), or XTest and XShm on X11 (§6). **Virtual screen** is an Xvfb display that the helper manages, holding the owner's apps under the owner's own user (§7). **Separate desktop** is a rootless Podman container built from the sandbox image, with a VM backend later (§8).
7. **Presence by password**: psyched asks polkitd directly for `com.psyche.presence.confirm` (`auth_self`, never cached). The helper isn't involved, because there's no signature to forward and only polkitd's own answer can be trusted (§9).
8. **Protocol changes are additive only**: a `password` presence kind, a desktop-only `approvals.approveWithPassword`, the `linux-helper` device family, Linux artifacts in the update manifest, and a `surface` on computer-use calls (`direct | virtual_screen | separate_desktop`) (§11).

---

## 0. Development status and handoff (2026-11-05)

**Linux development is paused on the owner's Mac and moves to a Windows machine** (WSL2 plus full Linux VMs). Only L0 is merged. L1–L4 are draft PRs with partial work and a resume list in each PR body. L5–L10 haven't started. GitHub Actions is locked by a billing issue, so none of the Linux CI jobs in §12 exist or run yet; until billing is fixed, verify locally.

### 0.1 Where each PR stands

| PR | Branch | State | Done | Left |
| --- | --- | --- | --- | --- |
| **L0** protocol | — | **Merged** ([#1272](https://github.com/devmello/psyche/pull/1272)) | `password` presence kind (Gateway-created only, not yet enforced), `approvals.approveWithPassword`, `devices.presence.status` with `PresenceVerifier`, the four `presence_*` error codes, `ComputerSurface`, `host-helper`/`guest` node kinds, `OsPermission` Linux values, `vscreen.*` capability shapes | Real Settings › Devices labels for `host-helper` and `guest`: they map to the Mac-helper and VM-guest labels for now (`DevicesSection.tsx`) |
| **L1** platform + systemd | `claude/linux-l1-platform` | Draft [#1276](https://github.com/devmello/psyche/pull/1276) | `apps/desktop/src/platform/` (the single `process.platform` read, traits, the shared `systemd-unit.ts` renderer, `SystemdUserSupervisor`, health, autostart, linger, tray probe, the safeStorage guard, the LUKS check, the uninstall strings in 10 languages). `LaunchdSupervisor` is renamed, with an alias kept, and `createSupervisor()` is used in main.ts. Desktop typecheck is clean | **The existing supervisor tests haven't been re-run since the refactor: run them first.** New tests (fake `Runner`, unit text, the lint rule). The CLI importing the shared renderer. `deploy/systemd/` units. main.ts wiring (setDesktopName, shortcuts, tray fallback, guard, linger, autostart). Linux branches in login-item, tray, dock-policy, windows and downloads. Real-Chrome paths. The Linux uninstall plan. Changeset and checks |
| **L2** packaging + updates | `claude/linux-l2-packaging` | Draft [#1274](https://github.com/devmello/psyche/pull/1274) | Linux artifacts and selection in the manifest; the update flow and the Linux updater branch (staged in `~/.cache/psyche/updates`); `linux-install.ts`, `linux-apply.ts` (AppImage rename with an EXDEV fallback and the previous copy kept; deb/rpm via `pkexec`; rollback); `linux-gateway.ts`; `deploy/linux/` setup script, `.desktop` file (10 languages), AppArmor profile, unit template, icons | Forge makers and `package.json` deps (plus the lockfile), `linux-bundle.ts`, the `psyche-apprun` script, AppRun, maintainer scripts, the `update-manifest.mjs`, `build-psyched.mjs` and size-budget Linux entries, every test, all checks. **The existing vitest suites haven't been re-run since the manifest edits** |
| **L3** Rust helper | `claude/linux-l3-helper` | Draft [#1275](https://github.com/devmello/psyche/pull/1275) | `apps/linux-helper` workspace: typify protocol types plus `cargo gen-check`, NDJSON framing, connect signing (v1, v2), identity (0600), the handshake secret, the node session, the approval guard, the `health`-only registry, backoff, idle exit, and the CLI flags. 59 tests pass, clippy is clean, and `cargo check --target x86_64-unknown-linux-gnu` passes | **The Gateway half:** registry host-helper families and the `host-helper` alias, the `auth.ts`/`server.ts` edits (a shared family list), and the peer check (Node has no `SO_PEERCRED`: parse `ss -xnp` plus `/proc`; pid reuse stays open). The conformance "host helper" profile. A first pairing run against a real psyched |
| **L4** password presence | `claude/linux-l4-password-presence` | Draft [#1273](https://github.com/devmello/psyche/pull/1273), **no code yet** | The full design is in the PR body: the fake-able D-Bus interface, the two-step check, a per-approval 256-bit nonce bound to `presenceChallenge(approvalId, bindingHash, answerToken)`, consumed once, rejecting client-sent `password` assertions | Everything. Needs `dbus-next` added and bundled. **Needs an independent security review before merge** |
| L5–L10 | — | Not started | — | Per §14 |

### 0.2 Corrections found while building

- **Install path.** electron-installer-debian/redhat install to **`/usr/lib/psyche`** and `/usr/bin/psyche`, not `/opt/Psyche` and `psyche-desktop`. L1's install-kind check (`dpkg -S`/`rpm -qf`) and §2.1 must use `/usr/lib/psyche`.
- **AppImage launcher.** The AppImage maker's AppRun is only a symlink to the bin, so Psyche's AppRun logic (`--psyched`, `--setup-system`, the userns sandbox check) is a shell script used as the AppImage `bin`.
- **Supervisor signature.** L1's final interface is `restart(reason: "build_mismatch" | "update")`. L2's adapter (`linux-gateway.ts`) assumed `restart(reason: string)`; align it when resuming. L2 uses only `restart` and `stopForUpdate`, and takes `restoreSnapshot`/`recordSkipBuild` as caller-supplied hooks.
- **Peer check.** Node can't call `getsockopt(SO_PEERCRED)`. The plan reads `ss -xnp` plus `/proc`. Pid reuse can't be closed without a pidfd, so §4.3 should say so.
- **The `password` kind** must be rejected from clients in `packages/permissions/src/handlers.ts`, a file outside L4's Owns list. Make that one edit there.

### 0.3 How to continue, in order

1. **Re-run the existing desktop tests on L1 (#1276) and L2 (#1274)** before adding anything: both refactored code whose tests haven't run since.
2. **Finish L1**, then merge. L2 depends on its supervisor.
3. **Finish L2**, aligning its supervisor adapter and the `/usr/lib/psyche` path, then merge.
4. **Finish L3** (the Gateway half and conformance), then merge. Merge `origin/main` into each branch with a merge commit, never a rebase or `reset --soft`.
5. **Build L4** from its PR body. Get an independent adversarial security review, then merge.
6. **L9 CI**, as soon as GitHub billing is fixed: the `linux-desktop`, `linux-smoke`, `linux-helper` and `linux-upgrade` jobs.
7. **Wave 2:** L5 (direct), L6 (virtual screen), L7 (container desktop). Then L8 (VM) and L10 (dictation).
8. The real-machine test plan in §13, recorded in `docs/guides/linux-test-results.md`.

### 0.4 What WSL can and can't test

| Area | WSL2 (with WSLg and `systemd=true` in `/etc/wsl.conf`) | Needs a full Linux VM (Hyper-V, VirtualBox or VMware, Ubuntu 24.04 GNOME Wayland plus one KDE or X11 desktop) |
| --- | --- | --- |
| Unit tests, typechecks, `cargo test` on Linux, `cargo gen-check` | Yes | — |
| The Gateway under `systemd --user`, the unit and drop-in, `systemd-analyze verify` | Yes, with systemd turned on | — |
| `electron-forge make` for deb, rpm and AppImage | Yes (needs `dpkg`, `fakeroot` and `rpm`; run AppImages with `APPIMAGE_EXTRACT_AND_RUN=1` if FUSE is missing) | Installing and launching from the desktop menu |
| The Rust helper pairing with psyched over `node.sock`, the peer check | Yes | — |
| X11 path and virtual screen (L6) under Xvfb, AT-SPI with GTK apps | Mostly (WSLg runs X11 apps through XWayland; start `at-spi2-core` yourself) | — |
| Container desktop (L7) with rootless Podman | Yes | — |
| **Direct mode on Wayland** (ScreenCast/RemoteDesktop portals, libei, restore tokens) | **No**: WSLg's compositor offers no screen-cast or remote-desktop portal | Yes, on GNOME and KDE |
| **Password presence** (the polkit dialog through a real session agent) | Only the **refusal** paths (`no_session`, `agent_missing`), plus python-dbusmock tests | The real dialog, approve, deny and cancel (§13 step 3) |
| Tray, autostart, global shortcuts, notifications, the uninstall sheet | Partly | Yes |
| VM backend (L8, QEMU/KVM) | Nested virtualization only, if enabled | A KVM-capable host |

### 0.5 Rules that still apply

Light, per-session tests: vitest with `--maxWorkers=1` on touched files, per-package typechecks, and never `pnpm -w typecheck` or `pnpm -r test`. Local checks before merge while Actions is locked: biome at error level, `bash scripts/ci/secret-grep.sh`, `pnpm protocol:check` and `pnpm i18n:check`. Every user-facing string gets all 10 languages. Security PRs (L3's peer check, L4 and L7's isolation) get an independent adversarial review. Each PR's file ownership in §14 stays disjoint while they run in parallel; locale files and guides take additions only.

---

## 1. Where things stand

| Piece | Linux today | Where |
| --- | --- | --- |
| Gateway, web UI, protocol, memory, search, connectors, browser, sandbox | Portable Node/TS; already runs on Linux in Docker or headless | `apps/gateway`, `packages/*`, `deploy/Dockerfile` |
| Headless node | Supports Linux (exec, fs, browser, health; vsock guest transport) | `apps/node` |
| systemd user unit | Exists for **server** use, written by `psyche start` | `deploy/systemd/psyche-gateway.service`, `apps/cli/src/supervisor.ts` (`SupervisorKind = "launchd" \| "systemd" \| "none"`) |
| Desktop supervisor | launchd only | `apps/desktop/src/main/supervisor.ts` (`SupervisorMode = "dev" \| "launchd" \| "external" \| "remote"`) |
| Packaging | `MakerZIP` for darwin and linux; `packageAfterPrune` returns early unless darwin | `apps/desktop/forge.config.ts` |
| Updater | darwin only (Squirrel.Mac); the manifest models only a `darwin` zip | `apps/desktop/src/main/updater.ts`, `update-manifest.ts` |
| Pre-update snapshot, rollback data, kernel lock | Cross-platform, in the Gateway (merged #1264). The lock uses an exclusive SQLite lock off macOS | `apps/gateway/src/pre-update.ts` |
| Native capabilities | Only the Swift Mac helper provides them | `apps/mac-helper` |
| Presence | Touch ID through the helper (`approvals.approveWithTouchId`), or WebAuthn passkeys | `apps/gateway/src/presence-gate.ts`, `compose/helper.ts`, `compose/passkeys.ts` |
| Host helper rule | Only a node declaring `deviceFamily: "mac-helper"` that presented the per-launch handshake secret on the node socket is the Host's helper | `apps/gateway/src/nodes/registry.ts` |
| Protocol | `DevicePlatform` already includes `linux`. `vm.*`, `screen.*` and `presence.*` are Apple-shaped. `PresenceAssertion.kind` is `webauthn \| helper` | `packages/protocol/src/schemas/identity.ts`, `schemas/permissions.ts` |
| CI | `ci.yml` has ubuntu and macos-26; the desktop job is macOS only. GitHub Actions is currently locked by a billing issue (2026-11-05), so new jobs run once the owner fixes billing | `.github/workflows/` |

---

## 2. Packaging and install

### 2.1 Formats

| Format | Ship? | Why | Cost |
| --- | --- | --- | --- |
| **deb** (`@electron-forge/maker-deb`) | **Yes, first class** on Debian, Ubuntu, Mint, Pop!_OS | Root at install time lets it put the polkit policy, the AppArmor profile, the `.desktop` file and the packaged systemd user unit in their system locations. Builds on Linux (or macOS) with `dpkg` and `fakeroot` ([Forge deb maker](https://www.electronforge.io/config/makers/deb)) | One admin prompt per install and per update |
| **rpm** (`@electron-forge/maker-rpm`) | **Yes, first class** on Fedora, openSUSE, RHEL clones | Same as deb. Needs `rpmbuild`, Linux only ([Forge rpm maker](https://www.electronforge.io/config/makers/rpm)) | Same |
| **AppImage** | **Yes, portable** | One file, no root, runs on most distros, can replace itself. Forge has no official AppImage maker; use the community `@reforged/maker-appimage` ([npm](https://www.npmjs.com/package/@reforged/maker-appimage), [repo](https://github.com/SpacingBat3/ReForged)) with the static **type2 runtime**, which no longer needs `libfuse2` on the host ([type2-runtime](https://github.com/AppImage/type2-runtime)) | No root means the polkit policy and (on Ubuntu) the sandbox fix need a one-time admin step (§2.6). If the community maker stalls, fall back to `appimagetool` in a script |
| Flatpak | **No** (revisit only for a "chat-only" build) | A Flatpak app can't install or run a `systemd --user` unit, can reach host processes only through `flatpak-spawn --host` (which Flatpak itself calls trusting the app to run code outside the sandbox, [advisory](https://github.com/flatpak/flatpak/security/advisories/GHSA-4ppf-fxf6-vxg2)), and reaches the accessibility bus only through a filtering proxy meant for an app to **expose** its own tree, not read other apps' ([flatpak#79](https://github.com/flatpak/flatpak/issues/79), [sandbox permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)). Portals (ScreenCast, RemoteDesktop, GlobalShortcuts) would work, but AT-SPI, the Gateway, the helper and Podman wouldn't. Flathub refuses apps that rely on host components for core functionality ([Flathub requirements](https://docs.flathub.org/docs/for-app-authors/requirements)) | — |
| Snap | **No** | Strict confinement has the same problems, and classic confinement needs store approval | — |
| zip / tarball | Keep `MakerZIP` for CI artifacts only | — | — |

Architectures: **x86_64 and aarch64**. aarch64 matters because the owner's test VM on an Apple-silicon Mac is aarch64 (§13).

Install layout (deb and rpm): `/opt/Psyche/` (Electron, `resources/app.asar`, `resources/psyched/` with its own Node 24, `resources/psyche-helper`), `/usr/bin/psyche-desktop` → `/opt/Psyche/psyche`, `/usr/share/applications/psyche.desktop`, icons under `/usr/share/icons/hicolor/`, `/usr/lib/systemd/user/psyche-gateway.service`, `/usr/share/polkit-1/actions/com.psyche.presence.policy`, and on Ubuntu `/etc/apparmor.d/psyche`. Everything is root-owned. That matters for §4.3 and §9.

The AppImage has the same tree inside its squashfs. Onboarding offers to move it to `~/Applications/Psyche.AppImage`. The AppImage spec says an AppImage may install its own `.desktop` file, but must ask first and must skip that if `appimaged` is running or `$DESKTOPINTEGRATION` is set ([AppImage spec](https://github.com/AppImage/AppImageSpec/blob/master/draft.md)). Psyche follows that: it writes `~/.local/share/applications/psyche.desktop` and icons after asking.

### 2.2 Where data lives

**Decision: keep `~/.psyche` (`$PSYCHE_HOME`) for all of the owner's data. App-level files follow XDG.**

| What | Where | Why |
| --- | --- | --- |
| The owner's data: state DBs, vault, workspace, library, browser profiles, backups, pre-update snapshots, `run/` sockets and the handshake secret, `secrets/` | `~/.psyche` (0700) | Same layout on macOS, Linux desktop, Linux server and Docker. The snapshot and restore code (#1264), `protected-paths.ts`, `psyche backup`, the uninstall sheet and every guide name one root. Splitting it across `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CONFIG_HOME` would make the snapshot and restore cover three folders, and make uninstall and backup easier to get wrong |
| Electron's own `userData` (window state, Chromium caches) | `~/.config/Psyche` (Electron's default) | Electron's choice; nothing of the owner's lives there |
| Caches (update downloads, sandbox image pulls stay in Podman's store) | `$XDG_CACHE_HOME/psyche` (default `~/.cache/psyche`) | Safe to delete, which is what the cache folder means |
| Helper state (portal restore tokens, virtual-screen config) | `$XDG_STATE_HOME/psyche-helper` (default `~/.local/state/psyche-helper`, 0700, files 0600) | Machine-local state, not data to back up. A restore token is useless on another machine |
| Previous AppImage for rollback | `~/.local/share/psyche/previous/` | Next to the running one, cheap on disk |

Cost: a dotfolder in `~`, which some Linux users dislike. `$PSYCHE_HOME` still overrides it, and the [XDG Base Directory spec](https://specifications.freedesktop.org/basedir/latest/) is followed for everything that isn't the owner's data.

### 2.3 The Gateway as a `systemd --user` unit, and one supervisor interface

The supervisor becomes an interface. The desktop and the CLI share the same unit text.

```
interface GatewaySupervisor {
  ensureRunning(build): Promise<GatewayRunState>   // install or refresh the unit, start it, wait for /healthz
  restart(reason): Promise<void>                   // build mismatch (handshake `server.build`), update
  stopForUpdate(): Promise<void>                   // after gateway.prepareUpdate: bootout / systemctl stop
  quitEntirely(): Promise<void>                    // remove the agent / disable the unit
  status(): Promise<{ loaded, active, pid?, lastExit? }>
}
LaunchdSupervisor   (today's code, moved)          SystemdUserSupervisor (new)
```

`chooseMode` gains `"systemd"`. The **unit text** comes from one renderer shared with `apps/cli/src/supervisor.ts`, which already renders and quotes a systemd unit. Move that into `apps/desktop/src/platform/systemd-unit.ts` and have the CLI import it, or move it to a small shared module. The PR that owns it decides.

| | deb / rpm | AppImage |
| --- | --- | --- |
| Unit file | Packaged at `/usr/lib/systemd/user/psyche-gateway.service` (the lowest-priority user unit path, [systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)) | Written by the desktop to `~/.config/systemd/user/psyche-gateway.service`, and rewritten only when its **content** changes (the plist rule) |
| `ExecStart` | `/opt/Psyche/resources/psyched/psyched` | `"<abs path of $APPIMAGE>" --psyched`. AppRun dispatches `--psyched` to `$APPDIR/resources/psyched/psyched`, so the daemon runs from the mounted image. Nothing is extracted, and the image stays mounted for the daemon's life (one small FUSE process) |
| Enable | The desktop runs `systemctl --user enable --now psyche-gateway.service` on first launch (no root needed) | Same |
| Update | The package manager replaces the files, then the desktop restarts the unit on a build mismatch | The running daemon keeps the old image's inode mounted. After the swap the desktop sees the build mismatch and runs `systemctl --user restart` |

The unit (both cases):

```ini
[Unit]
Description=Psyche Gateway (psyched)
After=default.target

[Service]
Type=simple
ExecStart=...
Environment=PSYCHE_BUILD=<build>         # the content check, as in the plist
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=yes
LockPersonality=yes
RestrictSUIDSGID=yes
MemoryHigh=768M                          # throttle, never kill; see below

[Install]
WantedBy=default.target
```

- **Not** `PartOf=graphical-session.target`. The Gateway also runs headless, after logout with lingering, or reached over SSH. `graphical-session.target` is for services that only make sense in a graphical session ([systemd.special](https://www.freedesktop.org/software/systemd/man/latest/systemd.special.html)), which is the helper (§4.4), not the Gateway.
- **No `DISPLAY` or `WAYLAND_DISPLAY`.** psyched needs neither. Presence talks to polkitd on the system bus (§9).
- **`MemoryHigh`** throttles reclaim instead of killing ([systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)). It's a guard against a runaway Gateway on a RAM-tight machine. The number comes from measuring idle psyched on Linux in PR L1. Leave `MemoryMax` unset, because an OOM kill in the middle of a migration is worse than slowness.
- **Lingering** (`loginctl enable-linger`, [loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)) stays an owner choice in Settings › General ("Keep Psyche running after I log out"). Off by default. With it off, the Gateway stops at logout like the Mac's LaunchAgent.
- **The vault key file.** On Linux the packaged Gateway uses the key-file slot (`$PSYCHE_HOME/secrets/vault.key`, 0600, the unsigned-Mac path from security §4.3.1). See §10.1 for why.
- **Dev mode** (`PSYCHE_HOME` set, unpackaged) keeps today's `dev` mode, which spawns psyched directly.

### 2.4 Autostart

- The **Gateway** starts with the user manager (`WantedBy=default.target`), so it needs no autostart entry.
- The **desktop window** opens at login only if the owner turns that on in Settings ("Open Psyche at login"). That writes `~/.config/autostart/psyche.desktop` with `Exec=… --hidden` ([XDG autostart spec](https://specifications.freedesktop.org/autostart/latest/)). Electron's `app.setLoginItemSettings` is macOS and Windows only, so `login-item.ts` gets a Linux branch. Off by default: the tray and the Gateway don't need the window.

### 2.5 Uninstall

Settings › About › **Uninstall Psyche…** reuses the existing sheet (`uninstall.ts`, translated in #1267), with Linux steps:
- **Always:** `systemctl --user disable --now psyche-gateway.service`. Stop the helper and any virtual screen or separate desktop (`podman rm -f` for Psyche's containers only, matched by label `com.psyche.owner=1`). Remove the user unit file if Psyche wrote it, plus `~/.config/autostart/psyche.desktop`, `~/.local/share/applications/psyche.desktop`, `~/.config/Psyche`, `~/.cache/psyche`, `~/.local/state/psyche-helper`, and the portal restore token (the helper revokes it first).
- **The app itself:** an AppImage is moved to the Trash (`gio trash`, never deleted). For deb and rpm the sheet shows the exact command (`sudo apt remove psyche` / `sudo dnf remove psyche`) and a button that runs it through `pkexec`. The package's `prerm` script does nothing to user data.
- **Checkbox, off by default:** "Also delete my Psyche data (`~/.psyche`)", with "Back up first", the same as on the Mac. Podman images go with it ("Also remove the separate desktop image, 1.3 GB").
- Removing the one-time AppImage integration (§2.6) needs an admin prompt. The sheet offers it and lists the files.

### 2.6 The one-time system integration (AppImage only)

deb and rpm install these at package time. An AppImage can't, so Settings and onboarding offer **"Set up password approvals"**, a single `pkexec` run of a small, fixed script shipped inside the image that installs:
1. `/usr/share/polkit-1/actions/com.psyche.presence.policy` (§9.2). polkit reads actions only from root-owned locations, which is the property we want: same-user malware can't edit the dialog text or the defaults.
2. On Ubuntu 23.10 and later, where `kernel.apparmor_restrict_unprivileged_userns=1` stops Chromium's user-namespace sandbox ([Ubuntu: restricted unprivileged user namespaces](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)): a root-owned copy of Electron's `chrome-sandbox` at `/usr/local/lib/psyche/chrome-sandbox` (setuid root), which AppRun passes through `CHROME_DEVEL_SANDBOX` ([Chromium SUID sandbox](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md)). A path-based AppArmor profile can't match an AppImage, because the image mounts at a random `/tmp/.mount_*` path, and a glob there would hand the user-namespace permission to anything mounted at that path. Until this step runs on such an Ubuntu, AppRun shows a `notify-send` message ("Use the .deb on Ubuntu, or run Psyche.AppImage --setup-system") instead of starting without the sandbox. **Psyche never runs with `--no-sandbox`.**

This is why deb is the recommended download on Ubuntu, and why the download page says so.

### 2.7 Keyring

See §10.1. In short: the Gateway uses the key file, and the desktop doesn't need the keyring for anything required.

---

## 3. Updates

### 3.1 What carries over unchanged

- The **Ed25519-signed manifest**, its pinned host, downgrade refusal, SHA-256 and size checks, channels (`update-feed/<channel>.json`) and signed notes (`update-flow.ts`, `update-manifest.ts`, `release-keys.ts`).
- The **pre-update snapshot**, restore on a failed migration, retention, the kernel lock and `update-failed.json`. They live in the Gateway, which is the same code on Linux (#1264). On Linux the lock is the exclusive SQLite lock already used off macOS.
- **`gateway.prepareUpdate`**, the busy gates ("never in the middle of work"), the launch probation, and the "Go back to 0.4.2?" splash.

Electron's `autoUpdater` doesn't exist on Linux ("There is no built-in support for auto-updater on Linux", [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)), so only the **apply step** is new.

### 3.2 The manifest gains Linux artifacts

`ManifestArtifact.platform` widens from `"darwin"` to `"darwin" | "linux"`, and `kind` from `"zip"` to `"zip" | "appimage" | "deb" | "rpm"`. `arch` is `x64 | arm64`. It's additive, and old macOS apps ignore entries they don't select. `selectArtifact` picks by platform, arch and the **install kind**, which the app knows from how it runs: `$APPIMAGE` set means `appimage`, otherwise the package that owns `/opt/Psyche` (`dpkg -S` or `rpm -qf`, checked once at startup). `deploy/scripts/update-manifest.mjs` emits the new entries. The same key signs everything.

### 3.3 AppImage: verified self-replace

```
check ─► verify manifest ─► download Psyche-<v>-linux-<arch>.AppImage to ~/.cache/psyche/updates/ (0700)
      ─► SHA-256 + size ─► chmod 0755 ─► "Restart to update" (busy gates, as on macOS)
      ─► 1. copy the running $APPIMAGE to ~/.local/share/psyche/previous/ (previous.json: version, build)
         2. gateway.prepareUpdate ─► systemctl --user stop psyche-gateway
         3. rename(new, $APPIMAGE)           // same filesystem: atomic. Otherwise copy beside it, then rename
         4. systemctl --user start psyche-gateway ─► relaunch the desktop from $APPIMAGE
```

- **Atomic and safe while running.** A rename over the running file leaves the old inode mounted for the processes using it, and the next start uses the new file.
- **Non-writable location** (for example `/opt` by hand): detect it with `access(W_OK)` on the parent and show "Download the update", the same fallback as on macOS.
- **Rollback**: "Go back" stops the unit, restores the pre-update snapshot (Gateway), renames `previous/Psyche.AppImage` back over `$APPIMAGE`, records `skip-builds.json`, and relaunches. It's the same screen and the same rules as on macOS §2.5.
- **zsync deltas: not in v1.** AppImage's embedded update information plus a `.zsync` file would give block deltas from GitHub Releases ([AppImage updates](https://docs.appimage.org/packaging-guide/optional/updates.html)). But it would also let third-party updaters (AppImageUpdate, Gear Lever) update Psyche **without** our Ed25519 check, channels or rollback. That's a second trust path. Full downloads match the macOS decision (D6: measure first). If deltas are wanted later, our updater runs zsync itself and still checks the final file's SHA-256 against the signed manifest. So **don't embed update information** in v1.

### 3.4 deb and rpm: download the verified package, then install it with the admin prompt

- The same check and verification, then "Restart to update" runs `pkexec /usr/bin/apt-get install --yes <file>.deb` or `pkexec /usr/bin/dnf install --assumeyes <file>.rpm`, after `prepareUpdate` and stopping the unit. The owner types the admin password into the system's own dialog once per update. A package manager that refuses (a dependency or a held package) shows its message, and the app stays on the current version.
- The file sits in a 0700 folder from verification until install. A same-user attacker could still race it, but that attacker could equally ask `pkexec` for anything; it's the same-user boundary security §1.3 already draws.
- **Rollback for deb and rpm:** the snapshot restore works as everywhere. Reinstalling the previous package needs that package, so keep the verified previous `.deb`/`.rpm` in `~/.cache/psyche/previous/` and reinstall it with `pkexec` (`apt-get install --allow-downgrades`, `dnf downgrade`). One admin prompt.
- **No signed apt or dnf repository in v1.** apt and dnf need **OpenPGP** signatures (`InRelease`/`Release.gpg`, `repomd.xml.asc`), not our raw Ed25519 manifest. A repo means a second long-lived key, a static host (GitHub Pages works, GitHub Releases doesn't fit apt's layout), and `apt upgrade` updating Psyche **outside** the busy gates and the pre-update flow. Revisit when users ask for `apt upgrade`. The repo's postinst would then tell the in-app updater to stand down, like Homebrew's `auto_updates true`.

### 3.5 The channel feed

No change: `releases/download/update-feed/stable.json` and `beta.json`, both signed. Each manifest lists every platform's artifacts. The release job builds Linux artifacts on `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64) and adds them to the same manifest (§12).

---

## 4. The Linux helper

### 4.1 Language and runtime

| | **Rust** (recommended) | Node/TS (reuse `apps/node`) | Go | Python |
| --- | --- | --- | --- | --- |
| RAM while running | ~5–20 MB RSS (estimate, measure in L3) | ~40–60 MB (a second Node process) | ~10–25 MB | ~30–50 MB plus GObject |
| AT-SPI | `atspi` crate on `zbus` ([docs.rs/atspi](https://docs.rs/atspi)) | `dbus-next`, hand-written | `godbus`, hand-written | `gi.repository.Atspi`, the best binding |
| Portals | `ashpd` (ScreenCast, RemoteDesktop with persistence, GlobalShortcuts; [docs.rs/ashpd](https://docs.rs/ashpd)) | hand-written over D-Bus | hand-written | hand-written |
| PipeWire frames | `pipewire` crate ([pipewire-rs](https://gitlab.freedesktop.org/pipewire/pipewire-rs)) | **no** pure-JS client; needs a native addon or a GStreamer subprocess | cgo | GStreamer |
| libei | `reis`, pure Rust ([docs.rs/reis](https://docs.rs/reis)) | none | none | none |
| X11 (XTest, XShm, window manager) | `x11rb`, pure Rust ([docs.rs/x11rb](https://docs.rs/x11rb)) | none worth using | `xgb` | `python-xlib` |
| wlroots protocols | `wayland-client` + `wayland-protocols-wlr` | none | partial | `pywayland` |
| Distribution | One binary per arch, built in CI, about 5–10 MB | Runs on psyched's bundled Node, so no extra disk | One binary | A runtime to ship |
| Reuse | Protocol types generated from `packages/protocol/generated/schema.json` (as `protocol-swift` is) | Highest: `apps/node` transports, identity, NDJSON | Low | Low |

**Decision: Rust.** It's the only option with maintained libraries for every piece the helper needs (AT-SPI, portals, PipeWire, libei, X11, wlroots), and it gives the lowest RAM while running. The costs:
- a third native toolchain in the repo, after Swift and TS;
- generating Rust types from the protocol's JSON Schema (`typify`) and adding a `gen:check` for them;
- builders who know Rust.

The Node option loses on PipeWire and libei, which are exactly the parts that need native code. Most of the helper's logic (snapshot rendering, tiers, risky labels, the node handshake) is plain Rust that compiles and tests on macOS too, with the Linux-only crates behind `cfg(target_os = "linux")` (§12.3).

### 4.2 IPC: the same node protocol as the Mac helper

The Gateway must see "a helper", not a Linux special case.

- **Transport:** NDJSON frames over `$PSYCHE_HOME/run/node.sock` (wire spec v1), the same socket, framing and `maxFrameBytes` as `FrameChannel.swift` and `apps/node/src/transports/ndjson.ts`.
- **Handshake:** `connect` with `role: "node"`, `platform: "linux"`, `deviceFamily: "linux-helper"`, an Ed25519 device identity, the challenge and `connect.verify`, plus the per-launch handshake secret from `$PSYCHE_HOME/run/handshake.secret`. That's exactly `NodeHandshakeClient`.
- **Capability manifest:** the same `NodeCapability` specs (side effect, target kind, permissions, receipt kind). Where the Mac helper has a capability with the same meaning, the Linux helper uses **the same name and the same result shape** (`computer.ax_tree` returns the `AXSnapshot` shape, `computer.click`, and so on), so `compose/computer.ts` needs no second driver. Linux-only additions are listed in §11.
- **Build identity:** `psyche-helper --print-identity` and `--build-info`, like the Mac helper. The pairing hello carries the build, and the desktop restarts a stale helper.

### 4.3 Pairing and identity

- **The host-helper rule generalizes.** `NodeRegistry.hostHelper` today accepts only `deviceFamily: "mac-helper"` with the handshake secret. It becomes **"a host-helper family"** (`mac-helper` on macOS, `linux-helper` on Linux) with the same conditions: it arrived on the node socket, it presented the per-launch secret, it never pairs by owner approval, the family is pinned at pairing, and a mismatch is denied. Internally the kind becomes `host-helper`, with `mac-helper` kept as an alias in stored rows. A node declaring `linux-helper` any other way is stored as `remote` and is never a candidate. That's the same defence as for `mac-helper` (security §10).
- **Peer check, a step better than the Mac for packaged installs.** Node has no `getsockopt(SO_PEERCRED)`, so psyched finds the peer the long way, and treats everything `ss` prints as attacker-influenced text. The accepted socket's inode G comes from `/proc/self/fd/<fd>`. In `ss -xnp` exactly two lines may mention G or the other end's inode A: our row (local G, peer A) and the peer's row (local A, peer G). A third line that mentions either number, or rows that don't fit, make the answer `unverified`; lines about other sockets are ignored, so an unrelated socket with a strange name can't stop pairing, and a `PSYCHE_HOME` with a space works. Who holds A comes from the kernel's own fd tables, not from `ss`: every `/proc/<pid>/fd` and `/proc/<pid>/task/<tid>/fd` is scanned (in bounded batches, with a deadline). Exactly one process must hold it, and it must be the pid `ss` named. A same-user process whose fd table can't be read (a non-dumpable fork can hide a copy of the socket while its parent execs the real helper) that is an ancestor, a descendant, or shares a same-user ancestor with the holder makes the answer `unverified`; unrelated unreadable processes (gpg-agent, Chromium's sandboxed processes, other users' processes) are ignored, because they can't have inherited this socket. A strict mode refuses on any unreadable same-user table. The helper also closes every inherited descriptor above 2 as its first act. The holder must still hold the socket, with the same start time, after psyched reads `/proc/<pid>/exe` (and `stat`s that link, so it sees the real file, not a path that could be remounted), `/proc/<pid>/maps` and `/proc/<pid>/environ`. The socket is paused until the check finishes, and a timed-out check is told to stop (its concurrency slot is freed only when it has).
  - **Verdicts.** `root_owned`: the packaged `/usr/lib/psyche/resources/linux-helper/psyche-helper`, root-owned, in root-owned directories nobody else can write, every file-backed executable mapping a root-owned, not group- or world-writable file under a system library directory or the package (identified by device and inode, not just the path), and no `LD_PRELOAD`, `LD_AUDIT` or `LD_LIBRARY_PATH` in its initial environment. The real helper with a foreign mapping or a loader variable is a `mismatch`. `user_owned`: another file named `psyche-helper` that the user owns (an AppImage, a dev build). `mismatch`: any other program. `unverified`: anything that could not be established (no `ss`, unparsable pairing rows, a peer already gone, two or hidden holders, unreadable `/proc` entries, a timeout, a busy checker, a deleted binary). A failure never becomes `root_owned`.
  - **Enforcement.** With the packaged helper installed, only `root_owned` can be the Host helper; `user_owned`, `unverified` and `mismatch` are refused, and `devices.hostHelper.status` carries `refused: { peerCheck, reason, ... }` so Settings can say why. With no packaged helper on disk (AppImage, dev), `user_owned` and `unverified` are accepted and recorded as `peerCheck` (with `peerCheckReason`); `mismatch` is always refused. That is the documented weaker mode, and Settings › Devices can name it, like the Touch ID key kinds. On a Gateway that ran the check, only the `linux-helper` family can be the Host helper, and `linux-helper` is never the Host helper on a macOS or Windows Gateway.
  - **What this proves, and what it doesn't.** It proves which binary file is running as the peer and that no foreign library is mapped executable into it at the moment of the check. A library preloaded through the loader runs before `main`, so the helper's own refusal to start with `LD_PRELOAD` or `LD_AUDIT` set is only hygiene; the Gateway's maps and environment check is what catches an injected library. It does not stop a same-user process from `ptrace`-ing the real helper where Yama allows it (`kernel.yama.ptrace_scope` 1, Ubuntu's default, limits ptrace to descendants, so a parent can), nor code written into the helper's memory afterwards. The helper can't close that by making itself non-dumpable: a non-dumpable process hides `/proc/<pid>/fd`, `exe`, `maps` and `environ` from its own user, which psyched reads, so every pairing would become `unverified`. **Pid reuse can't be fully closed** without a pidfd taken at accept, which Node doesn't offer; the holder scan, the start-time and the second look shrink the window to milliseconds, they don't remove it, and the process holding the socket is not necessarily the one writing to it. A same-user process can also keep the checker busy so the real helper is told `busy` and retries. This is the accepted same-user boundary (security §1.3). For the **AppImage** the binary sits inside a user-owned image, so the check proves less still.
- **The desktop launches nothing it can't vouch for.** It starts the helper only from its own install path, and only against a loopback Gateway (the existing rule).
- **Presence isn't the helper's job on Linux** (§9.3). So unlike the Mac, a fake helper can't fake an approval. The most it can do is lie about the screen, which content taint already treats as untrusted.

### 4.4 Lifecycle: zero idle cost

The helper has no always-on job on Linux. There's no hold-to-talk key tap, presence is in psyched, and notifications go through Electron. So it runs **on demand**:
- It's a user unit, `psyche-helper.service` (`PartOf=graphical-session.target`, `After=graphical-session.target`, `Type=simple`), packaged next to the Gateway's or written by the desktop for the AppImage. GNOME and KDE import `WAYLAND_DISPLAY`, `DISPLAY` and the session bus address into the user manager when the session starts. A session that doesn't is detected (the helper can't open a display), and the desktop then passes them with `systemctl --user import-environment` before the start ([systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)).
- psyched starts it with `systemctl --user start psyche-helper.service` when a computer-use session, a screen ask, or a virtual screen begins, and waits for the node to connect (up to 5 s).
- The helper exits after **5 minutes** with no computer-use session, no virtual screen and no watch view open. The Mac's 2-minute session idle stays; the process outlives it a little, so a follow-up action doesn't pay a cold start.
- On a headless or SSH-only machine the unit can't start (no graphical session), and the computer-use tools say "Needs a graphical session on this computer". The separate desktop still works (§8).

---

## 5. Computer use: three modes on one set of tools

| | **Direct** | **Virtual screen** | **Separate desktop** |
| --- | --- | --- | --- |
| What it drives | The owner's own desktop, which the owner sees | An invisible display on the owner's machine, holding the owner's apps under the owner's user, with the owner's real files | A container (later a VM) with its own apps and files |
| Owner keeps working? | No: Psyche moves the real pointer and keyboard | **Yes** | Yes |
| Touches the owner's files | Yes | Yes | Only folders the owner shares |
| Touches the owner's apps and sessions (keyring, logged-in apps) | Yes | Yes (same session bus and keyring) | **No** |
| Cost at rest | 0 | 0 | 0 |
| Cost while running | the helper + one PipeWire stream | the helper + Xvfb + the apps | the container + its apps |
| Best for | "Do this in the app I have open" | Background work in the owner's apps | Risky, unattended or untrusted tasks |
| Protocol `surface` | `direct` | `virtual_screen` | `separate_desktop` |

**How this maps onto the existing tools and rules.**
- **Same tools.** `computer.snapshot`, `computer.act`, `computer.screenshot`, `computer.check_target`, `apps.list`, `apps.open` and `apps.focus` gain an optional `surface` (default `direct`), carried on the computer-use session. A session is bound to one surface, and one session per surface drives at a time. `apps.applescript`, `apps.shortcut_run` and `apps.shortcuts_list` aren't advertised by the Linux helper, so the Gateway doesn't register them. Capabilities are discovered, never assumed (cross-platform §4.3).
- **App identity.** Targets are **desktop file ids** (`org.gnome.TextEditor`, `firefox`, `libreoffice-writer`). The helper resolves a running AT-SPI application to its desktop id through the process's cgroup and `GIO_LAUNCHED_DESKTOP_FILE`, falling back to `/proc/<pid>/exe` matched against `.desktop` `Exec=` lines. Per-app tiers in `computer-use.json` and the broker key on that id, exactly as on the Mac with bundle ids.
- **Fixed caps get a Linux list** in `computer-settings.ts`:
  - **Browsers, read only:** firefox, chromium, google-chrome, brave, vivaldi, epiphany.
  - **Terminals and IDEs, click only:** gnome-terminal, ptyxis, konsole, kitty, alacritty, wezterm, foot, xterm, code, codium, jetbrains-*.
  - **Off and not overridable from chat:** password managers (keepassxc, bitwarden, 1password, seahorse, kwalletmanager5/6), banking and trading apps.
- **Secure fields:** AT-SPI role `PASSWORD_TEXT` (`ATSPI_ROLE_PASSWORD_TEXT`) is refused at the helper's dispatch layer and redacted from snapshots and screenshots, like `AXSecureTextField`.
- **Risky labels and chords** are the same list (`RISKY_WORDS` and the helper's copy), so they still ask on "Read and interact". One exception, in the separate desktop only: file-local words (delete, trash, remove, erase, clear, empty, discard) don't ask there, because the container can only touch its own files and the shares the owner chose. Words that reach the outside world (send, submit, purchase, buy, pay, transfer) still ask everywhere.
- **Approvals** (`computer_action`, bound to the exact call) and "while you're away" for mail and messaging apps apply unchanged. A virtual screen or separate desktop is unattended by design, so those cards **park the Task** instead of failing the call, which is what `awaiting_attention` is for.
- **Stop.** On the Mac a global Esc tap stops computer use. On Linux:
  - **Direct on Wayland:** the portal session itself is the kill switch. GNOME and KDE show a "screen is being shared" indicator with a Stop control, and closing the session ends input. The helper treats `Closed` as Esc and cancels the run. The desktop also shows a floating Stop control.
  - **Direct on X11:** `XGrabKey` on Escape during a session, consumed, like the Mac.
  - **Virtual screen and separate desktop:** Stop in the watch view, plus Task cancel.

---

## 6. Direct computer use

### 6.1 Structure and actions: AT-SPI2

- **How it connects.** The helper calls `org.a11y.Bus.GetAddress` on the session bus to find the accessibility bus. It then reads the tree from `org.a11y.atspi.Registry` and each application's `org.a11y.atspi.Accessible` objects, with the `Component`, `Action`, `Text`, `EditableText`, `Value` and `Selection` interfaces, and subscribes to events through the registry ([AT-SPI2 on freedesktop](https://www.freedesktop.org/wiki/Accessibility/AT-SPI2/), [libatspi reference](https://docs.gtk.org/atspi2/), [at-spi2-core](https://gitlab.gnome.org/GNOME/at-spi2-core)).
- **Mapping to today's capabilities:**
  - `computer.ax_tree` walks the focused application (or the one named) into the same `AXSnapshot` shape, with refs and budgets. AT-SPI roles map onto the snapshot's role words in one table, which the conformance suite checks.
  - `computer.press` uses `Action.DoAction` (index of "click"/"press"/"activate").
  - `computer.set_value` uses `EditableText.SetTextContents` or `Value.SetCurrentValue`.
  - `computer.select` uses `Selection.SelectChild`.
  - `computer.menu` walks the menu bar's accessible children by label path.
  - `computer.ax_value` uses `Text.GetText` with a cap.
- **Turning accessibility on.** Many toolkits export their tree only when they believe an assistive technology is running:
  - **Chromium and Electron:** read `org.a11y.Status.IsEnabled`, honour `ACCESSIBILITY_ENABLED=1`, and fall back to GNOME's `toolkit-accessibility` setting ([Chromium `atk_util_auralinux.cc`](https://source.chromium.org/chromium/chromium/src/+/main:ui/accessibility/platform/atk_util_auralinux.cc)).
  - **GTK 3 and 4:** export whenever the bus exists.
  - **Qt:** checks `IsEnabled`, with `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` as a force (to verify on the test machine).
  - **Firefox:** `GNOME_ACCESSIBILITY=1`, or `IsEnabled`.
  - **Java:** needs `java-atk-wrapper`.

  So, when Computer use is turned on in Settings, the helper sets `org.a11y.Status.IsEnabled = true` (what a screen reader does), and says so in Settings: "Apps opened from now on expose their structure to Psyche. Apps already open may need a restart." Apps that Psyche itself launches also get `ACCESSIBILITY_ENABLED=1`, `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` and `GNOME_ACCESSIBILITY=1` (§7). Cost: a little RAM and CPU in every accessible app while on. Turning Computer use off sets the flag back, unless something else (Orca) had already set it.
- **Coordinates on Wayland are the known gap.** A Wayland client doesn't know where its window sits on screen, so `Component.GetExtents` in screen coordinates returns 0,0 or window-relative values ([GTK #6343](https://gitlab.gnome.org/GNOME/gtk/-/issues/6343), [GTK #5149](https://gitlab.gnome.org/GNOME/gtk/-/issues/5149)). The helper therefore:
  1. prefers **actions that need no coordinates** (`DoAction`, `SetTextContents`, `GrabFocus` and keys), which covers most `computer.act` calls;
  2. on KDE, gets each window's frame geometry from KWin's scripting D-Bus API and adds the window-relative extents;
  3. on GNOME, has no supported way to read window positions (there's no Shell extension in v1). A ref without an action falls back to keyboard focus and keys, then to screenshot coordinates the model picks, and the snapshot marks such refs "no position".

  X11 and the virtual screen (§7) don't have this gap.

### 6.2 Pixels and input on Wayland: the portals

- **One combined session.** `RemoteDesktop.CreateSession`, then `SelectDevices` (keyboard and pointer, `persist_mode = 2`, `restore_token` if one is stored), then `ScreenCast.SelectSources` (monitors, `cursor_mode` embedded), then `Start`. It's **one** owner dialog, and it returns PipeWire streams and a new restore token ([ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html), [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)). When the two portals are combined, persistence goes through `SelectDevices`.
- **Approve once.** The token is **single use**: each `Start` returns a new one, and the helper stores the newest (0600, `$XDG_STATE_HOME/psyche-helper/portal.json`). A token the backend can't restore is ignored and the owner sees the dialog again. Settings › Computer use shows "Screen and input access: allowed until you revoke it" with a Revoke button.
- **Pixels.** `OpenPipeWireRemote` gives an fd. The helper connects with `pipewire-rs`, targets the stream by `pipewire-serial` (interface v6), and keeps only the latest frame. `computer.screenshot` encodes that frame (downscaled as on the Mac). The stream runs **only during a computer-use session**, so between sessions there's no capture cost.
- **Input.**
  - **Through libei** when the portal offers `ConnectToEIS` (RemoteDesktop v2). The compositor hands the helper an EIS socket, and input goes through `reis` straight to the compositor, which can tell it apart from physical input ([libei](https://libinput.pages.freedesktop.org/libei/)).
  - **Otherwise** through the portal's own `NotifyPointerMotionAbsolute` (relative to a stream), `NotifyPointerButton`, `NotifyPointerAxis` and `NotifyKeyboardKeysym`.
  - Text goes in as keysyms. Long text is pasted through the clipboard only when the field accepts it and the call allows it, as on the Mac.
- **Focus.** On GNOME, Wayland doesn't let a client raise another app's window. `apps.focus` uses AT-SPI `GrabFocus` on the window and reports `focus: "requested"`. If focus didn't move, it answers `focus_denied` and the agent asks the owner to switch. KDE can activate windows through KWin scripting.

### 6.3 GNOME, KDE and wlroots

| | GNOME (mutter, xdg-desktop-portal-gnome) | KDE Plasma 6 (KWin, xdg-desktop-portal-kde) | wlroots (sway, Hyprland, labwc…) | X11 session |
| --- | --- | --- | --- | --- |
| Tree | AT-SPI | AT-SPI | AT-SPI | AT-SPI |
| Pixels | ScreenCast portal | ScreenCast portal | ScreenCast via xdg-desktop-portal-wlr, or `wlr-screencopy` / `ext-image-copy-capture-v1` directly ([xdpw](https://github.com/emersion/xdg-desktop-portal-wlr), [ext-image-copy-capture](https://wayland.app/protocols/ext-image-copy-capture-v1)) | XShm |
| Input | RemoteDesktop portal (EIS when offered) | RemoteDesktop portal (EIS) | **No RemoteDesktop portal** in xdpw. The helper connects as a Wayland client and uses `zwlr_virtual_pointer_v1` and `zwp_virtual_keyboard_v1` ([virtual pointer](https://wayland.app/protocols/wlr-virtual-pointer-unstable-v1), [virtual keyboard](https://wayland.app/protocols/virtual-keyboard-unstable-v1)) when the compositor exposes them | XTest |
| Persistence (approve once) | Restore tokens. ScreenCast since xdg-desktop-portal-gnome 42; RemoteDesktop persistence per [MR 88](https://gitlab.gnome.org/GNOME/xdg-desktop-portal-gnome/-/merge_requests/88) (**verify the release on the test machine**) | Restore tokens (KDE Connect relies on them; verify across reboots) | No dialog at all: any client may use those protocols unless the compositor restricts them | No dialog |
| Window positions | none (gap) | KWin scripting | `wlr-foreign-toplevel` gives no positions; sway IPC (`get_tree`) does | XQueryTree |
| Kill switch | Shell's sharing indicator | Plasma's sharing indicator | none built in, so the desktop's Stop control | Esc grab |

**wlroots honesty.** On sway and friends, any client may inject input and read the screen without asking. Psyche can't add a consent step the compositor doesn't have, so Settings says this when it detects wlroots, and the first Direct session there shows Psyche's own one-time explanation card.

### 6.4 The X11 fallback

When `XDG_SESSION_TYPE=x11`: XTest for input (`XTestFakeKeyEvent`, `XTestFakeButtonEvent`, `XTestFakeMotionEvent`, [XTEST spec](https://www.x.org/releases/current/doc/xextproto/xtest.html)), MIT-SHM for capture, and AT-SPI screen coordinates (which work on X11). No portal dialog is needed, because X11 has no permission model. Settings › Computer use says plainly: "On X11 any app can read your screen and keystrokes, including your password when you approve something (§9.6)." XTest into Xwayland under a Wayland session reaches only X apps, and recent Xwayland may route it through the portal anyway, so the helper never uses XTest when `WAYLAND_DISPLAY` is set.

---

## 7. Virtual screen

### 7.1 What runs

**Decision: an Xvfb display that the helper manages itself, under the owner's user and session bus.** A headless Wayland compositor comes later, only if Wayland-only apps need it.

| Option | For | Against |
| --- | --- | --- |
| **Xvfb + the helper as a tiny window manager** (chosen) | In every distro (`xvfb` / `xorg-x11-server-Xvfb`). XTest and XShm work with no prompts. AT-SPI screen coordinates are correct, so refs click precisely. Small (estimate 15–30 MB plus the framebuffer, 4 MB at 1280×800×32). Apps' X11 backends (GTK 3/4, Qt, Electron, Firefox, LibreOffice) are mature | X11 is legacy, and GTK has said its X11 backend won't last forever. A few Wayland-only apps won't open |
| Headless sway (`WLR_BACKENDS=headless`) | Real Wayland. Screencopy and virtual input for any client. sway IPC gives window rects | sway isn't installed on GNOME or KDE desktops. It's a tiling WM to tame, and more moving parts |
| weston `--backend=headless` / `pipewire` ([weston(1)](https://man.archlinux.org/man/weston.1)) | Frames to PipeWire | No virtual-input protocol for clients. Its screenshooter is debug-only |
| mutter `--headless --virtual-monitor` | GNOME-native | Built for a separate nested GNOME session with its own bus, so heavy. Not meant to run inside the user's session |
| gamescope, cage | — | Single-app kiosk compositors; the wrong shape |

**The helper is the window manager.** With `x11rb` it takes `SubstructureRedirect` on the Xvfb root, maps each new top-level window maximised, keeps one in front (cage-like), and sets focus with `XSetInputFocus`. Dialogs are centred above their parent. That's a few hundred lines, and it means no extra WM package and full control over geometry and focus.

### 7.2 Launching apps there, and keeping them off the real display

- `apps.open { surface: "virtual_screen", app: "<desktop id>" }` starts the app from its `.desktop` file in a **transient systemd scope**: `systemd-run --user --scope --slice=psyche-vscreen.slice --unit=psyche-vs-<id>`. Its environment:
  - `DISPLAY=:<n>`, `WAYLAND_DISPLAY` **unset**, `GDK_BACKEND=x11`, `QT_QPA_PLATFORM=xcb`, `MOZ_ENABLE_WAYLAND=0`, `--ozone-platform=x11` for Chromium and Electron;
  - the accessibility flags from §6.1;
  - `XDG_ACTIVATION_TOKEN` and `DESKTOP_STARTUP_ID` removed.
- It keeps the owner's **session bus and keyring**, which is the point: the owner's files, logged-in mail client and so on.
- **Single-instance apps are the escape hatch.** Many apps hand a new launch to an instance already running (a GApplication's unique D-Bus name, Firefox's remote service, Chromium's profile lock, LibreOffice's pipe). The new window would then open **on the real display**. The rules:
  1. **Before launch**, the helper checks whether the app already runs on the real display: its desktop id's D-Bus name is owned, or a process with its executable runs outside `psyche-vscreen.slice`. If so, `apps.open` answers `already_open_on_your_screen` and offers Direct mode instead. It never asks the running instance to open a window.
  2. **Per-app launch recipes** where an app supports a second instance: Firefox `--no-remote --profile <owner profile copy-on-first-use>` (a second Firefox can't share a profile that's in use; the recipe says so and refuses while Firefox is open), Chromium-family `--user-data-dir`, LibreOffice `-env:UserInstallation=file://$XDG_STATE_HOME/psyche-helper/lo`, VS Code `--user-data-dir`. Each recipe lists its tradeoff (a separate profile has no logged-in sessions), and the table lives in the helper with a test per entry.
  3. **After launch**, the helper checks that a new top-level window was mapped **on its display** within 10 s. If none was, it answers `opened_elsewhere`, and the run stops so the owner isn't surprised by a stray window.
- **AT-SPI is shared.** Apps on the virtual display use the same session bus, so they appear on the same accessibility bus as the owner's real apps. The helper filters by process: an AT-SPI application is in the virtual screen only if its pid (from `GetConnectionUnixProcessID` on the a11y bus) is in `psyche-vscreen.slice`. Direct mode sees **only** apps outside that slice. So the two surfaces can't drive each other's apps, even though they share one bus.

### 7.3 Capture and input

XShm capture of the root window, XTest input on `:n`, AT-SPI screen coordinates and actions. All of it stays inside the helper's own X server: nothing reaches the owner's display, and no portal dialog appears.

### 7.4 Lifecycle and RAM

- **Start on demand** at the first `surface: "virtual_screen"` call. `Xvfb :<n> -screen 0 1280x800x24 -nolisten tcp -auth <0600 file in $XDG_RUNTIME_DIR/psyche>` ([Xvfb(1)](https://www.x.org/releases/current/doc/man/man1/Xvfb.1.xhtml)) runs as a child of the helper, in the same slice. `n` is the first free display number from 90 up.
- **Stop when idle.** When the Task that used it ends, the helper sends `WM_DELETE_WINDOW` to each app. An app that shows a "Save changes?" dialog is **not** forced: the Task parks with a card ("Writer has unsaved changes in the virtual screen. Look / Discard / Keep it open"). With no apps left and no Task using it for 10 minutes, Xvfb stops, then the helper's idle timer runs.
- **RAM.** 0 at rest. While running: the helper (estimate 10–20 MB), Xvfb (estimate 15–30 MB) and the apps, which dominate (Firefox 300 MB+, LibreOffice 150 MB+). PR L6 measures the real numbers on the test machine and puts them in Settings. `psyche-vscreen.slice` gets `MemoryHigh` from a setting (default 2 GB), so a runaway app is throttled instead of taking the machine down.

### 7.5 The watch view

- The desktop gets a **Virtual screen** pane: a live view, Stop, "Take over" (the owner's clicks and keys are forwarded through the helper's XTest, and the agent pauses while the owner drives), and the list of open apps.
- **Frames are pulled, not streamed.** `vscreen.frame { since }` returns the newest JPEG when it changed. The pane polls it at up to 4 fps **only while it's visible** (`attention.report` already tells the Gateway when panes are visible). There's no cost when nobody watches, and no new streaming channel.
- The same pane and method serve the separate desktop (§8.5).

---

## 8. Separate desktop

### 8.1 Container first, VM later

| | **Rootless Podman container** (v1) | **QEMU/KVM VM** (later, optional) |
| --- | --- | --- |
| Isolation | Its own filesystem, user namespace, no host D-Bus, no display socket, no host home. **Shares the host kernel** | Its own kernel. Only virtio devices cross |
| Start | 1–2 s | 10–30 s (cold), a few seconds from a saved state |
| RAM while running | estimate 80–150 MB plus its apps | 1–2 GB guest, reserved while it runs |
| Disk | the `desktop` image, about 1.3 GB (estimate), shared layers with the sandbox `base` image | a 3–5 GB guest image |
| Needs | Podman (or Docker), which the sandbox already uses | `/dev/kvm` access (group `kvm`), QEMU, a guest image we build |
| Fits | "Can't touch my real apps", risky or unattended tasks | Untrusted code, kernel-level isolation, an untrusted website plus downloads |

**Decision: v1 ships the container. The VM is a later backend behind the same `separate_desktop` surface,** chosen in Settings › Computer use › Separate desktop › "Stronger isolation (uses about 2 GB of memory while running)". A container is enough to keep a task away from the owner's real apps and files. A VM costs a gigabyte or more while it runs, which this owner minds.

### 8.2 The image: reuse the sandbox image

- Add a `desktop` target to `deploy/sandbox-image/Dockerfile` **on top of `base`**: `xvfb`, `dbus`, `at-spi2-core`, fonts, `firefox-esr`, a small file manager, `libreoffice` (shared with `full`'s layer where possible), and the Linux helper binary. It keeps every sandbox rule: UID/GID 1000 `psyche`, read-only root filesystem, `/tmp` tmpfs, `/workspace` volume, `harden.sh` (no setuid), pinned digests, cosign-signed publishing (`publish.sh`) and `versions.json`.
- **The entrypoint** is a tiny init that starts a private `dbus-daemon --session`, `Xvfb :1`, the at-spi bus launcher, then `psyche-helper --surface separate_desktop`. Inside the container, the helper is the window manager, the same code as §7.
- The image is pulled at first use, never at install, and the pull shows its size.

### 8.3 How it connects to the Gateway

- The container has **no network by default** (`--network=none`), so the helper inside connects over a **Unix socket bind-mounted** into the container: `$PSYCHE_HOME/run/guest-<id>.sock` → `/run/psyche/node.sock`.
- That socket follows the **guest socket rules** the Mac's VM relay already has (`run/guest.sock`, security §10): never auto-paired, never loopback-trusted, never a host-helper candidate. Each start mints a single-use pairing token (written into the container's env at start), which pairs the guest helper as kind `guest`, bound to that container id and revoked when the container is removed.
- The Gateway routes `surface: "separate_desktop"` calls only to that guest node.

### 8.4 Files, network, credentials

- **Files: none by default.** The container sees only its own `/workspace` (a named volume per separate desktop, so it persists across starts until "Reset").
- **Shares are explicit folders**, read-only by default (`--volume <host>:/shares/<name>:ro`), read-write only through a per-folder approval. They follow security §13: never `~`, `~/.psyche`, `~/.ssh`, `~/.gnupg`, `~/.config` or `/` (`protected-paths.ts`). Write-back otherwise goes through "Copy to my computer", which leaves a receipt.
- **Network: off by default.** "Allow internet for this task" connects it through the existing egress proxy (`packages/sandbox/src/egress`) with the Task's origin allowlist. It never uses host networking, and it can never reach the host's loopback or LAN services (Podman's `pasta` with `--map-gw` off, plus the proxy as the only route).
- **Credentials:** the vault stays on the host. A fill into the separate desktop works like a fill into the agent browser: an approval, then one credential, typed by the helper into one field, never stored in the container. That's the §13 "host vault as a node capability" rule.
- **Clipboard:** none between the container and the host, except "Paste into separate desktop" from the watch view.

### 8.5 Lifecycle and cost

- **Created** on first use: `podman run -d --rm=false --userns=keep-id --read-only --tmpfs /tmp --cap-drop=all --security-opt=no-new-privileges --network=none --label com.psyche.owner=1 --memory=<setting, default 2g> …`. That's the sandbox runner's flags plus the socket mount ([podman-run](https://docs.podman.io/en/latest/markdown/podman-run.1.html)). Backend detection reuses `packages/sandbox/src/detect.ts` (`podman`, then `docker`). Rootless Docker works the same; rootful Docker gets the same warning the sandbox already gives.
- **Stopped** when the Task ends and no watch view is open, after the same unsaved-changes check as §7.4. **Removed** only on "Reset separate desktop". **Zero resident cost**: there's no daemon and nothing running between tasks (Podman is daemonless).
- **Watch view:** the §7.5 pane, with frames from the guest helper's `vscreen.frame`. No VNC or noVNC server is needed, so there's no extra listener and no password.

### 8.6 The VM backend (later)

- Plain `qemu-system-*` with KVM: `-display none`, `virtio-gpu`, a virtio-vsock device, `virtiofsd` for explicit shares (read-only by default), and `-nic none`, or user networking through the egress proxy only ([QEMU invocation](https://www.qemu.org/docs/master/system/invocation.html)).
- The guest runs `apps/node` (it already speaks vsock) plus the Linux helper. That's the same shape as macOS VM mode, so `compose/vm.ts`, `VmPhase`, `VmShare`, `VmClipboardMode` and the snapshot methods carry over with a `qemu` backend next to `VZBackend`.
- libvirt (`qemu:///session`, [libvirt URIs](https://libvirt.org/uri.html)) isn't used. It's another daemon for features we don't need.

---

## 9. Presence by password

### 9.1 What we can and can't get from polkit

From polkit's D-Bus API and source ([CheckAuthorization](https://polkit.pages.freedesktop.org/polkit/eggdbus-interface-org.freedesktop.PolicyKit1.Authority.html), [polkit(8)](https://polkit.pages.freedesktop.org/polkit/polkit.8.html), `polkit_backend_interactive_authority_check_authorization` in [polkit](https://github.com/polkit-org/polkit)):
- `CheckAuthorization(subject, action_id, details, flags, cancellation_id)` returns `(is_authorized, is_challenge, details)`. `flags = 1` is **AllowUserInteraction**, which blocks while the session's authentication agent asks the user. `CancelCheckAuthorization(cancellation_id)` cancels it.
- A same-uid, unprivileged caller may check **its own process** (`unix-process`, with a pidfd on polkit ≥ 124) or another subject of **the same user**, but **only with empty `details`**. Non-empty details, including `polkit.message`, need uid 0 or the action's `org.freedesktop.policykit.owner`. **So Psyche can't put the approval's text into the dialog.** The dialog shows the `.policy` file's fixed, translated message.
- `auth_self` asks for the session owner's password **every time**. The `_keep` variants retain the authorization "for a brief period" afterwards, so Psyche never uses them.
- The authentication agent is per session (GNOME Shell's built-in one, `polkit-kde-agent` on KDE, `polkit-gnome` or `lxpolkit` and others elsewhere). The answer comes back through `polkit-agent-helper-1`, which runs as root and checks the password with PAM. A same-user program can't produce that answer without the password.
- For a process outside any logind session, such as a `systemd --user` service, polkitd falls back to the user's **display session** (`sd_uid_get_display`). With no graphical session there's no agent, and the check fails without a prompt.

Versions with these properties: Ubuntu 24.04 ships polkit 124, Debian 13 has 126, and Fedora 43 has 126.

### 9.2 The action

`/usr/share/polkit-1/actions/com.psyche.presence.policy`, root-owned:

```xml
<action id="com.psyche.presence.confirm">
  <description>Approve an action in Psyche</description>
  <message>Psyche needs your password to approve the action you just allowed in the Psyche window.
Psyche only asks right after you click Allow. If you didn't, cancel.</message>
  <!-- plus xml:lang="…" translations for all ten app languages -->
  <defaults>
    <allow_any>no</allow_any>
    <allow_inactive>no</allow_inactive>
    <allow_active>auth_self</allow_active>
  </defaults>
</action>
```

- `allow_any` and `allow_inactive` are **no**. Only an active, local session can approve, never an SSH session or a locked or switched-away one.
- `auth_self`, never `auth_self_keep`, so nothing is cached.
- There's no `org.freedesktop.policykit.exec.path`, because nothing runs as root.

### 9.3 Who calls it: psyched, directly

**Decision: psyched calls polkitd itself, over the system bus. The helper isn't involved.**
- Touch ID works through the helper because the helper returns a **signature** that the Gateway verifies against a registered key. A fake helper can't forge that signature. polkit gives no signature, only a yes or no **to the caller**. If the helper asked and reported "yes", the Gateway would be trusting a same-user claim that anything holding the handshake secret could make. Only an answer polkitd gives psyched over psyched's own D-Bus connection can be trusted.
- psyched is the TCB already (security §1.4), and it's always running, so no extra process exists.
- **Implementation:** `dbus-next` (pure JS, no native code), loaded lazily the first time presence is needed. That's the idle-RAM rule.
- **The subject:** psyched looks up the owner's **active local graphical session** through logind (`org.freedesktop.login1`: `ListSessions` for its uid, then `Type` is `wayland` or `x11`, `Active`, `Remote = false`, and it has a seat). It passes that as the `unix-session` subject with empty details. That way psyched decides, before any dialog, whether a prompt can be shown and where, instead of relying on the display-session fallback. If L4's tests on a real machine show polkit refusing a same-user `unix-session` subject from a caller outside it, the fallback is psyched's own `unix-process` subject (pidfd), which reaches the same session through `sd_uid_get_display`.

### 9.4 The flow, and how the card binds to it

```
Card (desktop window): [Allow]  code 3fa9c2d1 · "Run `npm publish` in ~/code/psyche"
   │ approvals.approveWithPassword { approvalId, answerToken }   (desktop shell connection only)
   ▼
Gateway: same checks as approveWithTouchId: this window's unused token, card armed,
         not rate limited, one presence prompt at a time (guard taken before the first await)
   │ 1. logind: an active local graphical session for this uid?      no → presence_unavailable_here
   │ 2. CheckAuthorization(session, com.psyche.presence.confirm, {}, flags=0)
   │      is_authorized = true without asking?                   → presence_not_enforced (refuse)
   │      action unknown?                                        → presence_policy_missing
   │ 3. CheckAuthorization(session, …, {}, flags=AllowUserInteraction, cancel="psyche-<approvalId>")
   │      card: "Type your password in the system dialog to approve 3fa9c2d1"
   ▼
polkit agent dialog (fixed text from the root-owned .policy) ─► PAM ─► polkitd ─► psyched
   │ authorized                     → answer once, presence {kind: "password"}
   │ dismissed / wrong / cancelled  → rejected answer (counts against the cap)
   │ no agent (not authorized, no prompt within 2 s of a challenge) → presence_agent_missing
```

- **Step 2 matters.** Some systems ship rules that say yes to everything for admins (for example "nopasswd" rules for `wheel`). Under such a rule, step 3 would succeed without a password. psyched therefore asks once **without** interaction first, and refuses presence on this machine if polkit already says yes. Settings › Devices then shows "A polkit rule on this computer approves Psyche without a password. Password approvals are off until it's removed."
- **Binding.** polkit can't carry the approval's text, so the binding happens inside psyched:
  - only one presence check runs at a time;
  - it's tied to one `approvalId`, `bindingHash` and `answerToken`, cancelled if the card expires or the run is cancelled, and its yes is consumed for that approval only;
  - it's offered `once` only, never `UNSANDBOXED`, as for Touch ID from the window;
  - it starts only from a click in the desktop window.

  The dialog says Psyche only asks right after a click, so a dialog that appears on its own is the signal something is wrong. The card shows the code and "Waiting for your password…" while the dialog is up, so the owner sees what the password is for in Psyche's own window.
- **Security settings** that need fresh presence (§10 of the security doc) already go through a `policy_change` card with `approvalId`, so they use the same path.
- **Notifications** on Linux carry Approve and Deny only for cards that don't need presence. For a card that does, the notification's button opens the card in the window.

### 9.5 Headless, SSH, no agent: refuse, never fake it

| Situation | What happens |
| --- | --- |
| No active local graphical session (SSH only, lingering after logout, a locked screen that logind reports inactive) | `presence_unavailable_here`: "Approve at this computer, or with a passkey from another device." Passkeys (`webauthn`) keep working as they do today |
| A desktop without a polkit agent (some minimal window managers) | `presence_agent_missing`: "No password dialog is available on this desktop. Install a polkit agent such as polkit-gnome or lxpolkit, or use a passkey." |
| The policy file isn't installed (an AppImage before §2.6) | `presence_policy_missing`, with a button for the one-time setup |
| `pkexec` as a fallback | **No.** pkexec runs a program as root under `auth_admin`, which is a different question (admin rights, not the owner's presence) and needs the exec annotation. It adds a root process for nothing |
| A Psyche-drawn password field checked by psyched through PAM | **No.** The renderer would handle the owner's password, which Psyche never does, and a Psyche-drawn dialog is exactly what malware imitates |

**"On by default"** means: on Linux, when the action is installed and step 2 passes, password presence counts as a verifier for `presenceStateFor`, with no enrollment step (there's nothing to register). The existing **sticky** rule applies: once it could verify, losing it (the policy removed, a nopasswd rule added) makes gated calls fail with `presence_required` instead of falling back to `operator.admin`. `psyched presence reset` on the machine clears that, as today. Turning password approvals off is itself a security setting that needs presence.

### 9.6 How the Gateway records it

- `PresenceAssertion.kind` gains `"password"`. It's never accepted from a client: only the Gateway creates it, after its own polkit check. An `approvals.answer` carrying `kind: "password"` is rejected.
- The decision record and receipt hold `presence: { kind: "password", verifier: "polkit", actionId: "com.psyche.presence.confirm", subject: "unix-session:<id>", checkedAt }`.
- The audit log gets `approval.password_from_window`, with the requesting device and the session id. Rejected and cancelled dialogs are audited as rejected answers.
- `devices.presence.status` (new, read-only) lists the verifiers: the Touch ID key (macOS), passkeys, and the password (Linux, with `ready`, `policy_missing`, `not_enforced`, `no_session` or `agent_missing`).

### 9.7 What it protects against, and how it compares with Touch ID

**It protects against:**
- **Prompt injection and a compromised turn:** the model can't type the password, and no tool reaches the polkit call.
- **A paired device, a chat channel or a web client approving a `requiresAuthentication` card** without someone at this computer.
- **A same-user program answering the polkit dialog without the password.** The answer must come from root's `polkit-agent-helper-1` after PAM, and a second agent can't register for a session that already has one.
- **Same-user edits to the dialog or its defaults,** because the `.policy` file is root-owned.

**It doesn't protect against:**
- **UI spoofing.** A same-user program can draw a look-alike password dialog and harvest the password. It can't answer Psyche's check with it unless it can also feed it to the real agent.
- **Keystroke snooping on X11.** On an X11 session any client can read keystrokes (XInput2) and inject them (XTest), so malware can both learn the password and type it into the real dialog. **On X11, password presence is a speed bump, not a boundary.** Settings says so. On Wayland, GNOME Shell's and KWin's dialogs aren't readable by other clients.
- **A same-user attacker who patches psyched itself.** That's easy for an AppImage in `~`, and harder for a root-owned deb/rpm install, but then `ptrace` is the question. It's the same-user boundary security §1.3 already accepts.
- **Shoulder-surfing, or a password reused elsewhere.** It's usually the same password as `sudo`, so phishing it costs more than phishing a Touch ID touch.

| | Touch ID (macOS) | Password via polkit (Linux) |
| --- | --- | --- |
| What proves presence | A Secure Enclave signature over the approval's challenge, verified by the Gateway against a registered key | polkitd's yes to psyched's own D-Bus call, after PAM checks the password |
| Bound to the exact approval | Cryptographically (the challenge has the binding hash and token) | By psyched's state: one check at a time, one approval, once only |
| The OS dialog names the action | Yes (fixed wording with the code and summary) | **No** (fixed text only; the code is on Psyche's card) |
| A same-user process can fake it | Not with the keychain key. With the dev file key it can ask for a signature behind its own prompt (the known release blocker) | Not without the password |
| A keylogger defeats it | No | **Yes on X11**, no on Wayland |
| Phishing value of the secret | None (a fingerprint can't be phished) | High (often the sudo password) |
| Works over SSH or headless | No | No (refused by design) |
| Setup | Register the helper's key in Settings › Devices | None for deb/rpm; one admin prompt for an AppImage |

Plainly: **password presence is weaker than Touch ID**, roughly what macOS gives when the owner chooses the account password instead of a fingerprint. It's still a real boundary against the adversaries Psyche worries about most (injected content, remote surfaces and chat), on Wayland. A FIDO2 security key through a local passkey could later give Linux a hardware-backed option (the passkey path already exists for the web UI). That's out of scope here.

---

## 10. Other platform services

### 10.1 Secrets

- **The vault key: the key-file slot** (`$PSYCHE_HOME/secrets`, 0700, file 0600). psyched runs headless under systemd and can't call Electron's `safeStorage`. And on GNOME and KDE the Secret Service (libsecret / KWallet) has **no per-app access control**: any same-user process can read any unlocked item. So the keyring would add protection only at rest, while logged out, which full-disk encryption gives better. The same exposure is already documented for unsigned macOS builds (security §2, "Unsigned-build key storage"). Onboarding checks for full-disk encryption (LUKS on `/` or `~`, via `lsblk -o TYPE,MOUNTPOINT`) and recommends it, as FileVault is assumed on the Mac. The recovery key is confirmed at setup.
- **Electron `safeStorage`** (for the desktop's own small secrets): backends `gnome_libsecret`, `kwallet`, `kwallet5`, `kwallet6`, or `basic_text`, which is a hard-coded key ([safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)). The desktop checks `getSelectedStorageBackend()` and **refuses to store anything** under `basic_text`.
- **A Secret Service slot for the vault key** (psyched talking to `org.freedesktop.secrets` over `dbus-next`) is a possible follow-up for owners without disk encryption. It isn't in this plan.

### 10.2 Notifications

Electron `Notification` (the freedesktop Notifications spec; actions where the server supports them) becomes the OS surface on Linux. Approve and Deny buttons go only on cards that need no presence (§9.4). Quiet hours and the in-app inbox are unchanged.

### 10.3 Tray

Electron `Tray` uses StatusNotifierItem, with an XEmbed fallback ([Tray](https://www.electronjs.org/docs/latest/api/tray)). KDE and Ubuntu (which ships the AppIndicator extension) show it. **Stock GNOME (Fedora) has no tray.** The desktop checks for `org.kde.StatusNotifierWatcher` on the session bus. Without it, closing the last window **quits the desktop process** (the Gateway keeps running), and the app is reopened from the launcher. That's the honest behaviour, instead of an invisible process using RAM.

### 10.4 Global shortcuts (the pop-up chat)

Electron's `globalShortcut` uses the GlobalShortcuts portal on Wayland, on by default in current Electron ([globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)). The app id must match the installed `.desktop` file (`app.setDesktopName("psyche.desktop")`), or GNOME silently denies every bind. GNOME shows its own consent dialog on the first bind, and KDE binds silently. The default is `Ctrl+Alt+Space`. `Alt+Space` is the window menu on GNOME and KDE.

### 10.5 Dictation and speech

| | Ship in v1? |
| --- | --- |
| Dictation into Psyche (pop-up and composer): renderer mic plus the Gateway's whisper path, Web Speech as a fallback | **Yes**, it's portable today |
| System-wide hold-to-talk | **Defer.** The GlobalShortcuts portal reports `Activated` and `Deactivated`, so hold-to-talk is possible on KDE and GNOME 48+. It's a later PR (L10) |
| Inserting dictated text into other apps | **Defer** with it. It would use the RemoteDesktop keyboard (§6.2) or clipboard paste, under the same J9 rule (only the desktop shell may call `dictation.*`) |
| Text-to-speech | **No**, the owner's standing decision |

### 10.6 The in-app browser

It's the same Electron and the same CDP bridge, so no change. The real-Chrome launcher (`lib/real-chrome.ts`) needs Linux paths: `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `brave-browser` and `microsoft-edge` on `PATH`, plus Flatpak'd browsers through `flatpak run com.google.Chrome`. `browser/downloads.ts` skips the quarantine xattr off macOS.

### 10.7 File pickers, "open with", deep links

- Electron's dialogs use the FileChooser portal on Linux (`defaultPath` needs portal v4, [dialog](https://www.electronjs.org/docs/latest/api/dialog)), so the native picker works under GNOME and KDE. The folder-access approval keeps using the picked path, not the agent's string.
- "Open" and "Reveal" use `shell.openPath` / `shell.showItemInFolder`, which go through `xdg-open` and the FileManager1 D-Bus interface.
- The `.desktop` file registers `MimeType=x-scheme-handler/psyche;` so pairing and app links open Psyche (`app.setAsDefaultProtocolClient` relies on it). Psyche doesn't claim any document types in v1.

### 10.8 Window chrome and Wayland

Electron 38+ defaults to `--ozone-platform=auto`, so Psyche runs as a native Wayland client in a Wayland session ([breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)). `windows.ts` already uses the native title bar off macOS. Glass mode, the dock and `screencapture` stay macOS-only. They're behind the platform module (L1), not scattered `process.platform` checks.

---

## 11. Protocol changes (additive only)

| Change | Where | Notes |
| --- | --- | --- |
| `PresenceAssertion.kind` += `"password"` | `schemas/permissions.ts` | Gateway-created only; rejected from clients (§9.6) |
| `approvals.approveWithPassword { approvalId, answerToken }` | `methods/approvals.ts` | Desktop shell connection only; same guards as `approveWithTouchId` |
| `devices.presence.status` → `{ verifiers: [{ kind: "touch_id_key" \| "passkey" \| "password", state, detail? }] }` | `methods/devices.ts` | Read-only, `operator.admin` |
| Error codes `presence_unavailable_here`, `presence_agent_missing`, `presence_policy_missing`, `presence_not_enforced` | `errors.ts` | With `details.reason` for the card |
| `ComputerSurface = "direct" \| "virtual_screen" \| "separate_desktop"` | `schemas/tools.ts` | The enum only. The tool params that carry it (`SnapshotParams`, `ActParams` and the rest) are local TypeBox schemas in `apps/gateway/src/compose/computer.ts`, so L5 adds the optional `surface` there, default `direct`, and the Mac is unchanged |
| `deviceFamily: "linux-helper"` recognized as a host-helper family | gateway registry (not a schema change) | §4.3 |
| Node kinds: `host-helper` (alias `mac-helper`), `guest` for separate-desktop helpers | `node.ts` | Stored rows keep `mac-helper` |
| Linux helper capabilities: `vscreen.start`, `vscreen.stop`, `vscreen.status`, `vscreen.frame`, `vscreen.input` (the watch view's take-over), `portal.status`, `portal.revoke`, `a11y.status`, `a11y.enable` | the helper's manifest; method shapes in `methods/screen.ts` (new `vscreen` block) | Host-only. `nodes.invoke` reaches only `*.status` |
| `OsPermission` values for Linux: `a11yBus`, `screenCastPortal`, `remoteDesktopPortal`, `x11` (informational) | `schemas/permissions.ts` | The cross-platform §4.2 generalization of `TCCPermission`, done just for these |
| Update manifest: `platform: "linux"`, `kind: "appimage" \| "deb" \| "rpm"` | desktop `update-manifest.ts` and `deploy/scripts/update-manifest.mjs` (not the wire protocol) | §3.2 |

Swift codegen picks up the enum additions. The Mac helper ignores the new values. No `protocolVersion` bump.

---

## 12. CI

GitHub Actions is locked by a billing issue as of 2026-11-05. The jobs below land anyway, and run once the owner fixes billing. Standard runners are free for public repos ([GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). Until then each PR states what it ran locally.

### 12.1 Jobs

| Job | Runner | What |
| --- | --- | --- |
| `linux-desktop` | `ubuntu-24.04` (x64), `ubuntu-24.04-arm` (arm64) | `pnpm install`; build psyched (`deploy/scripts/build-psyched.mjs`, Linux Node runtime with SHA-256 check); `cargo build --release` for the helper; `electron-forge make` for deb, rpm and AppImage; size budget (`deploy/size-budget.json` gains `linux` entries); upload artifacts |
| `linux-smoke` | `ubuntu-24.04` | Install the built `.deb` (`sudo apt-get install ./psyche_*.deb`); run `psyched --bundle-check`; start psyched with a temp `PSYCHE_HOME`, wait for `/healthz`; `xvfb-run -a /opt/Psyche/psyche --smoke` (renders the main window, connects, exits 0); the same for the AppImage with `--appimage-extract-and-run` (no FUSE needed on the runner); `systemd-analyze --user verify` on both units; `pkaction --action-id com.psyche.presence.confirm --verbose` shows the installed defaults |
| `linux-helper` | `ubuntu-24.04` | `cargo fmt --check`, `clippy -D warnings`, `cargo test` (unit tests), then the **integration tests**: a private `dbus-run-session` with `python-dbusmock`'s `polkitd` and `logind` templates ([python-dbusmock](https://github.com/martinpitt/python-dbusmock)), a mock portal (dbusmock with a small custom template), a real `at-spi2-registryd` plus a GTK 4 test app under `Xvfb`, and the helper's virtual-screen backend driving that app end to end (open, snapshot, type, read back) |
| `linux-upgrade` | `ubuntu-24.04` | `deploy/scripts/upgrade-roundtrip.mjs` against the previous release's Linux psyched and the new one (snapshot and migrations on real data) |
| `ci` (existing) | ubuntu + macos-26 | Unchanged. The gateway's polkit client and supervisor tests are plain unit tests with fakes, so they run here on both |

KVM isn't needed by any job. The VM backend's tests (L8) use a fake QEMU runner, plus one optional job that checks `ls -l /dev/kvm` first and adds the udev rule GitHub documents ([changelog](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/)).

### 12.2 Release

`release.yml` gains Linux build jobs (x64 and arm64) feeding the existing manifest job: AppImage, deb and rpm per arch, `SHA256SUMS`, Linux entries in `update-manifest.json` and the channel feeds. There's no signing secret beyond `RELEASE_SIGNING_KEY`. The `desktop` sandbox image target joins `publish.sh` (cosign keyless, as today).

### 12.3 Testing the helper without Linux

- **Unit tests on macOS.** The helper's core is plain Rust, and the Linux-only crates sit behind `cfg(target_os = "linux")` and traits (`A11yTree`, `InputSink`, `FrameSource`, `Display`). `cargo test` on the Mac covers:
  - AT-SPI role → snapshot mapping, from recorded JSON fixtures of real trees;
  - refs, budgets, secure-field redaction, tiers, fixed caps and risky labels;
  - the node handshake against a fake Gateway socket;
  - the launch-recipe table;
  - the window-manager state machine, driven by fake X events.
- **Cross-compile on macOS** with `cargo zigbuild --target x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu` to catch Linux build errors. It needs no container or VM.
- **The node conformance suite** (`packages/testing/src/conformance/NodeClient.ts`) gains a "host helper" profile: golden manifest, invoke fixtures and refusal cases. Both helpers run it.
- **The Gateway side** (polkit client, logind lookup, supervisor, update apply) uses injected fakes, with the same pattern as `presence-keys.ts` tests. `zbus`'s and `dbus-next`'s message layers are behind a small interface, so tests replay recorded D-Bus replies.
- **Needs real Linux:** the portal dialogs and restore tokens, EIS, GNOME and KDE agents, AppArmor on Ubuntu, Wayland coordinates, the tray on each desktop, and RAM numbers. That's §13.

---

## 13. Test plan on a real Linux machine or VM

**Tell the owner before starting.** A desktop VM uses 4–6 GB of the Mac's memory while it runs, so the owner pauses other sessions first (the standing rule). Each run below is meant to be one sitting, with the VM shut down afterwards.

**Machines**

| # | Distro and session | Why | VM (UTM on the Mac, aarch64) |
| --- | --- | --- | --- |
| T1 | **Ubuntu 24.04 LTS, GNOME, Wayland** (required) | The most common desktop; AppArmor userns; polkit 124; the AppIndicator tray | 4 GB RAM, 4 vCPU, 40 GB disk |
| T2 | **Fedora 43 KDE Plasma 6, Wayland** (required) | KDE portals, KWin, rpm, no Ubuntu patches | 4 GB, 4 vCPU, 40 GB |
| T3 | **Ubuntu 24.04 "Ubuntu on Xorg"** session (required, same VM as T1) | The X11 path and the X11 warning | — |
| T4 | Fedora 43 Workstation (GNOME, no tray) or Debian 13 with sway (optional) | Stock GNOME without a tray; wlroots | 4 GB |

**Steps (T1, then T2 with rpm, then T3)**
1. **Install.** Download the `.deb` (T2: `.rpm`) built by CI. Then `sudo apt install ./psyche_*.deb`, and check that `/usr/share/polkit-1/actions/com.psyche.presence.policy`, `/usr/lib/systemd/user/psyche-gateway.service` and the AppArmor profile exist. Open Psyche from the launcher, and check `systemctl --user status psyche-gateway` is active and the window connects. Record idle RSS for psyched (`ps -o rss`) and the desktop.
2. **AppImage** (T1 only, a fresh user account): run `Psyche-*.AppImage`. Check the Ubuntu sandbox message appears, run `--setup-system` (one admin prompt), check it now starts, and that the unit's `ExecStart` names the AppImage.
3. **Password presence.**
   - Trigger an `exec_host` command that needs presence and click Allow. Check the GNOME dialog shows the translated Psyche message. Type a wrong password (rejected, the card counts it), then the right one (approved once). Check the audit entry `approval.password_from_window`.
   - Repeat right away: the dialog must ask again (no caching).
   - Lock the screen, approve from the phone: refused with `presence_unavailable_here`.
   - Over SSH into the VM, run `psyche approvals …`: same refusal.
   - Add a temporary `/etc/polkit-1/rules.d/00-test.rules` returning YES for the action: Settings shows `not_enforced` and approvals refuse. Remove the rule.
   - T2: the same with KDE's agent.
   - T3: the same, and confirm Settings shows the X11 warning.
4. **Direct computer use.**
   - Turn it on and check `org.a11y.Status.IsEnabled` is true. Open Text Editor (GTK 4), LibreOffice and Firefox.
   - Ask Psyche to type a paragraph into Text Editor and save to `~/Documents/test.txt`. Check the portal dialog appears **once**.
   - Restart the helper (`systemctl --user restart psyche-helper`) and the VM, then repeat. Expect **no dialog** (restore token). Record whether it survived the reboot, on GNOME and KDE.
   - Stop sharing from the top-bar indicator mid-task: the run cancels.
   - Check a password field in Firefox is redacted in the snapshot.
   - Note which refs have "no position" on GNOME.
5. **Virtual screen.**
   - Ask for a task in LibreOffice Writer on the virtual screen while typing in another app. Confirm nothing appears on the real display, the watch pane shows Writer, and Take over works.
   - Open Text Editor on the real screen, then ask for Text Editor on the virtual screen: expect `already_open_on_your_screen`.
   - Leave unsaved changes and end the task: expect the card.
   - Record RSS for Xvfb, the helper and Writer. Check everything is gone 10 minutes after the task.
6. **Separate desktop** (T1 only; `sudo apt install podman` first): run a task with no shares and no network. Confirm it can't see `~`. Share `~/Documents/share-test` read-only and check a write fails. Allow internet for one origin and check another origin fails. Record image size, start time and RSS, and confirm `podman ps` is empty after the task.
7. **Update and rollback.** Install N−1, point `PSYCHE_UPDATE_FEED` at a test feed on the pinned host (a pre-stable checklist item, as on macOS), update to N: AppImage self-replace, deb with one admin prompt. Then force a failed launch (a bad build flag in the test feed) and use "Go back".
8. **Tray, shortcuts, notifications.** Tray on T1 and T2, and its absence on T4 (closing the window quits the desktop, the Gateway stays). `Ctrl+Alt+Space` opens the pop-up after GNOME's consent dialog. A notification with Approve on a no-presence card.
9. **Uninstall.** The sheet with "keep data", then check the unit is gone and `~/.psyche` remains.

Record the results in `docs/guides/linux-test-results.md` (L9) with distro versions, portal versions and the RAM table.

---

## 14. PR plan

PR ids are `L0`–`L10`. "Owns" lists the files and folders a PR may change, and PRs that run at the same time own disjoint sets. Shared append-only hotspots are noted: the locale files in `packages/ui/src/i18n/messages/*` and `docs/guides/*`. Resolve those by keeping both sides, as the conflict resolver already does. Every PR follows the ops rules: light tests and typecheck per session, no VMs or containers on the Mac, and real-Linux checks deferred to §13 and listed in the PR body.

**Can start immediately, in parallel: L0, L1, L2, L3, L9 (the CI skeleton).** L4's Gateway polkit client can start at once too. It merges after L0.

| # | Scope | Owns | Depends on | Done means | Tested without Linux | Needs real Linux |
| --- | --- | --- | --- | --- | --- | --- |
| **L0** | **Protocol additions** (§11): `password` presence kind, `approvals.approveWithPassword`, `devices.presence.status`, the four error codes, the `ComputerSurface` enum, `host-helper`/`guest` node kinds, `vscreen.*` method shapes, Linux `OsPermission` values. Codegen regenerated | `packages/protocol/src/**`, `packages/protocol/generated/**`, `packages/protocol-swift/**` (generated output only) | — | `pnpm --filter @psyche/protocol gen:check` and tests pass; Swift package still builds in CI | Unit tests, codegen check | — |
| **L1** | **Desktop platform layer and systemd supervisor** (§2.2–2.5, §10.1–10.4, §10.6–10.8): `apps/desktop/src/platform/` (one module for platform checks, plus a lint rule for new `process.platform` uses outside it), `GatewaySupervisor` interface with `LaunchdSupervisor` (moved) and `SystemdUserSupervisor`, the shared unit renderer (CLI imports it), the `psyche-helper.service` unit text, lingering setting, autostart, Linux uninstall steps, tray fallback, `setDesktopName`, `Ctrl+Alt+Space` default, real-Chrome Linux paths, `safeStorage` `basic_text` refusal, the full-disk-encryption check | `apps/desktop/src/main/{supervisor.ts,login-item.ts,tray.ts,uninstall.ts,dock-policy.ts,windows.ts,startup.ts}`, `apps/desktop/src/main.ts`, `apps/desktop/src/platform/**` (new), `apps/desktop/src/lib/real-chrome.ts`, `apps/desktop/src/main/browser/downloads.ts`, `apps/cli/src/supervisor.ts`, `deploy/systemd/**` | — | On macOS nothing changes (launchd tests pass unchanged); systemd supervisor unit-tested with a fake runner (`systemctl` argv, content-change rule, build mismatch restart); the unit passes `systemd-analyze verify` in CI | Unit tests with fake `Runner`; existing desktop tests | Steps 1, 8, 9 of §13 |
| **L2** | **Packaging and updates** (§2.1, §2.6, §3): forge makers (deb, rpm, AppImage via `@reforged/maker-appimage`), install tree `deploy/linux/root/**` mirrored into packages, AppRun with `--psyched` and `--setup-system`, the setup script (polkit policy install, setuid sandbox copy), deb/rpm maintainer scripts, `.desktop` file and icons, manifest `linux` artifacts, the Linux apply step (AppImage rename, deb/rpm via `pkexec`), rollback of the previous artifact, `build-info` for Linux, size budgets. The polkit policy file itself is L4's, dropped into L2's tree | `apps/desktop/forge.config.ts`, `apps/desktop/package.json`, `apps/desktop/src/packaging/**`, `apps/desktop/src/main/{updater.ts,update-flow.ts,update-manifest.ts,release.ts,release-keys.ts}`, `deploy/linux/**` except `deploy/linux/root/usr/share/polkit-1/**`, `deploy/scripts/{update-manifest.mjs,build-psyched.mjs}`, `deploy/size-budget.json` | — (L1 for the restart call; L2 calls the `GatewaySupervisor` interface that L1 adds, so agree on its signature from §2.3 on day one) | `electron-forge make` produces deb, rpm and AppImage on Linux CI; manifest tests cover selection by platform, arch and install kind; apply step unit-tested with a fake fs and fake `pkexec` | Manifest and apply tests with fakes on macOS; `make` only on CI | §13 steps 1, 2, 7 |
| **L3** | **Linux helper skeleton, IPC and pairing** (§4): `apps/linux-helper` Rust crate (workspace, `typify`-generated protocol types plus `gen:check`), NDJSON node client, Ed25519 identity, handshake secret, reconnect backoff, `--print-identity`, `--build-info`, idle exit, the capability registry with no capabilities but `health`; Gateway: host-helper families, `linux-helper` family, `host-helper` kind alias, `SO_PEERCRED` + `/proc/<pid>/exe` peer check and `peerCheck` in Settings › Devices; conformance "host helper" profile | `apps/linux-helper/**` (new), `apps/gateway/src/nodes/registry.ts`, `apps/gateway/src/transports/**` (the accept-time peer check), `packages/testing/src/conformance/NodeClient.ts` | L0 (node kinds) for merge; can start at once | Helper pairs with a real psyched on Linux CI over `node.sock` and passes the conformance profile; a `linux-helper` on the wrong socket is stored as `remote` | `cargo test` on macOS; gateway registry unit tests; `cargo zigbuild` cross-build | — (CI covers it) |
| **L4** | **Password presence end to end** (§9): the `.policy` file with ten translations; psyched's polkit client (`dbus-next`, lazy), logind session lookup, the two-step check, cancellation on expiry; `approvals.approveWithPassword`; `password` in decisions, receipts and audit; `presenceStateFor` counting polkit; `devices.presence.status`; the desktop card ("Type your password in the system dialog…"), Settings › Devices rows, the four refusal messages, i18n in all ten languages; security doc §3.7, §10 and a new "Linux specifics" section updated | `apps/gateway/src/compose/password-presence.ts` (new), `apps/gateway/src/presence-gate.ts`, `apps/gateway/src/compose/approval-tokens.ts`, the approvals card and Settings › Devices components in `packages/ui/src/**` (approvals and devices only), `apps/desktop/src/main/bridge/**` (the new IPC method only), `deploy/linux/root/usr/share/polkit-1/**`, `docs/05-security-and-permissions.md`; locale files (append-only) | L0; L2 for packaging the policy file (it lands in L2's tree either order) | On Linux CI with dbusmock's polkitd and logind: approve, deny, cancel, no-session, no-agent, already-authorized, policy-missing all produce the right answer and audit; on macOS nothing changes | Unit tests with a fake D-Bus; dbusmock on CI | §13 step 3 on T1, T2 and T3 |
| **L5** | **Direct computer use** (§5, §6): AT-SPI snapshot and actions, the `IsEnabled` switch, portal session with restore tokens (`ashpd`), PipeWire frames, EIS input (`reis`) with the portal `Notify*` fallback, wlroots virtual pointer/keyboard and screencopy, X11 XTest/XShm, KWin window geometry, desktop-id resolution, Stop via the portal `Closed`; Gateway: `surface` plumbing in `compose/computer.ts`, Linux fixed caps and app ids in `computer-settings.ts`, hiding Apple-only tools | `apps/linux-helper/src/{a11y,direct,portal,wayland,x11,apps}/**`, `apps/gateway/src/compose/computer.ts`, `apps/gateway/src/compose/computer-settings.ts`, the Computer use section of Settings in `packages/ui/src/**` | L3; L0 | Snapshot → act → screenshot works on Linux CI against a GTK 4 app under Xvfb (X11 path) and a mocked portal; the Mac path's tests are unchanged | Fixture-based unit tests on macOS; CI integration | §13 step 4 on T1, T2, T3 (and T4 for wlroots) |
| **L6** | **Virtual screen** (§7): Xvfb lifecycle, the helper as a window manager, launch in `psyche-vscreen.slice` scopes, the single-instance checks and launch recipes, AT-SPI filtering by slice, unsaved-changes parking, idle stop, `vscreen.*`, the watch pane (pull frames, Take over) in the desktop and UI | `apps/linux-helper/src/vscreen/**`, `apps/gateway/src/compose/virtual-screen.ts` (new), `packages/ui/src/screens/computer-watch/**` (new), `apps/desktop/src/main/pop-outs.ts` (the watch pane only) | L3; uses L5's `a11y` module (start on the X11 and WM parts at once, integrate after L5's a11y merges) | On Linux CI the helper opens a GTK 4 app on its own Xvfb, snapshots, types and reads back, and nothing maps on the runner's main Xvfb; the watch pane renders frames in a Storybook story with fixtures | WM state machine and recipe tests on macOS; UI stories | §13 step 5 |
| **L7** | **Separate desktop, container backend** (§8.1–8.5): `desktop` image target, entrypoint, the per-container guest socket, single-use pairing token, `guest` node kind routing, Podman lifecycle with the sandbox flags and labels, shares through the folder-access approval, egress-proxy wiring, stop and reset, Settings rows | `deploy/sandbox-image/**` (the `desktop` target and its entrypoint; the existing targets untouched), `packages/sandbox/src/desktop.ts` (new), `apps/gateway/src/compose/separate-desktop.ts` (new), `apps/gateway/src/nodes/guest-sockets.ts` (new) | L3 (helper binary); L6's X11/WM backend inside the container (build the image and lifecycle at once; wire the helper after L6) | On Linux CI: build the image, start it with `--network=none`, the guest helper pairs as `guest` over the mounted socket, opens an app, and a write to a read-only share fails | Lifecycle with a fake Podman runner on macOS (no containers locally) | §13 step 6 |
| **L8** | **Separate desktop, VM backend** (§8.6), later and optional: QEMU runner, guest image build, vsock to `apps/node` in the guest, virtiofs shares, `qemu` next to `VZBackend` in `compose/vm.ts` | `packages/sandbox/src/qemu/**` (new), `deploy/linux/guest-image/**` (new), `apps/gateway/src/compose/vm.ts` | L7 | A guest boots under KVM on a runner that has it and pairs; the fake-QEMU tests pass everywhere | Fake QEMU runner | A KVM-capable Linux host (heavy: tell the owner) |
| **L9** | **CI and docs** (§12, §13): `linux-desktop`, `linux-smoke`, `linux-helper`, `linux-upgrade` jobs; release jobs for Linux artifacts and the `desktop` image; `docs/guides/install-linux.md`; `docs/guides/linux-test-results.md` template; the support matrix in `docs/08-roadmap.md` and `README` | `.github/workflows/**`, `docs/guides/install-linux.md` (new), `docs/guides/linux-test-results.md` (new), `docs/08-roadmap.md`, `README.md` (support matrix lines only) | Starts at once with a typecheck-and-unit job; each later job lands with or after the PR it exercises | All Linux jobs green on a branch once billing is fixed | Workflow lint (`actionlint`) locally | — |
| **L10** | **Later: system-wide dictation on Linux** (§10.5): hold-to-talk through the GlobalShortcuts portal, insertion through the RemoteDesktop keyboard | `apps/desktop/src/main/dictation/**`, `apps/linux-helper/src/dictation/**` | L5 | — | — | Yes |

**Order in practice.**
- **Wave 1 (now):** L0, L1, L2, L3, L9 (skeleton), and L4's Gateway half.
- **Wave 2:** L4 completes after L0, and L5 starts after L3. L6 starts its X11 and WM part, and L7 starts the image and lifecycle.
- **Wave 3:** L6 integrates L5's a11y module, L7 wires the helper, and the first T1/T2 test run (§13) happens with the owner's go-ahead.
- **Later:** L8 and L10.

With the ≤5 working sessions cap, wave 1 is five sessions: L0 and L9 are small Haiku/Sonnet jobs, while L1, L2 and L3 are Sonnet.

---

## 15. Decisions for the owner (recommendation first)

| # | Decision | Recommendation |
| --- | --- | --- |
| LD1 | Helper language | **Rust** (§4.1). The alternative is Node on psyched's runtime, which is less new tooling but needs native addons for PipeWire and libei, and more RAM while running |
| LD2 | Recommended download per distro | **deb on Debian/Ubuntu, rpm on Fedora/openSUSE, AppImage elsewhere** (§2.1, §2.6). The alternative is AppImage everywhere, which means a one-time admin step on Ubuntu before it even starts |
| LD3 | Separate desktop backend for v1 | **Container (rootless Podman), VM later as "Stronger isolation"** (§8.1) |
| LD4 | Virtual screen technology | **Xvfb managed by the helper** (§7.1). A headless Wayland compositor only if Wayland-only apps need it |
| LD5 | Password presence on X11 sessions | **On, with a plain warning** that it's a speed bump there (§9.7). The alternative is to refuse password presence on X11, leaving passkeys only |
| LD6 | When there's no polkit agent or no local session | **Refuse, and point to a passkey** (§9.5). No pkexec, no Psyche-drawn password field |
| LD7 | deb/rpm updates | **In-app verified download plus the system admin prompt; no apt/dnf repo in v1** (§3.4) |
| LD8 | AppImage zsync deltas | **No in v1**: one trust path (§3.3) |
| LD9 | Data location | **`~/.psyche`** (§2.2) |
| LD10 | Vault key on Linux | **Key file, plus a full-disk-encryption check in onboarding** (§10.1). A Secret Service slot later if wanted |
| LD11 | Architectures | **x86_64 and aarch64** (needed for testing in a VM on the Mac) |
| LD12 | The first real-Linux test session | **Ubuntu 24.04 GNOME Wayland in UTM, 4 GB RAM**, after wave 2, scheduled with the owner so other sessions can pause (§13) |

---

## 16. Risks and unknowns

| Risk or unknown | Mitigation |
| --- | --- |
| RemoteDesktop restore tokens may not persist on GNOME (the MR 88 release is unconfirmed) or across reboots on KDE | Test in §13 step 4. If they don't persist, the owner sees one portal dialog per helper start, which is still once per working session because the helper stays up during a task |
| polkit refuses a same-user `unix-session` subject from a caller outside it | Fallback to psyched's own process subject (§9.3); covered by L4's real-machine test |
| GNOME window positions stay unavailable on Wayland, so ref clicks without an action fall back to screenshots | Actions first; the virtual screen has exact coordinates; a GNOME Shell extension is a possible later option, deliberately not in v1 |
| Single-instance apps open their window on the real display | Pre-launch check, recipes, post-launch check (§7.2); the run stops instead of guessing |
| `@reforged/maker-appimage` stalls | It's one maker; fall back to `appimagetool` called from a forge hook |
| Electron or Chromium sandbox changes on Ubuntu (AppArmor) | deb ships a profile; the AppImage uses the setuid sandbox copy; never `--no-sandbox` |
| X11 sessions make password presence weak | Said plainly in Settings (LD5) |
| Toolkit accessibility gaps (Qt, Java, Flatpak'd apps exposing less) | Screenshot fallback, and the snapshot says which app gave no tree |
| A third native toolchain (Rust) | CI covers it; the crate keeps its core platform-neutral so macOS developers can test it |
| RAM numbers in this doc are estimates | L1, L5, L6 and L7 each measure on the test machine and replace them |
| GitHub Actions locked by billing | Jobs land anyway; each PR lists what it ran locally until the owner fixes billing |

---

## References

- polkit: [polkit(8)](https://polkit.pages.freedesktop.org/polkit/polkit.8.html), [org.freedesktop.PolicyKit1.Authority](https://polkit.pages.freedesktop.org/polkit/eggdbus-interface-org.freedesktop.PolicyKit1.Authority.html), [pkexec(1)](https://polkit.pages.freedesktop.org/polkit/pkexec.1.html), [source and NEWS](https://github.com/polkit-org/polkit)
- systemd: [systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html), [systemd.special](https://www.freedesktop.org/software/systemd/man/latest/systemd.special.html), [systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html), [loginctl](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html), [sd_uid_get_display](https://www.freedesktop.org/software/systemd/man/latest/sd_uid_get_state.html)
- XDG: [Base Directory spec](https://specifications.freedesktop.org/basedir/latest/), [Autostart spec](https://specifications.freedesktop.org/autostart/latest/)
- AT-SPI: [AT-SPI2](https://www.freedesktop.org/wiki/Accessibility/AT-SPI2/), [libatspi](https://docs.gtk.org/atspi2/), [at-spi2-core](https://gitlab.gnome.org/GNOME/at-spi2-core)
- Portals: [ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html), [RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html), [GlobalShortcuts](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html), [Background](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Background.html)
- libei: [libei and libeis](https://libinput.pages.freedesktop.org/libei/)
- Wayland protocols: [wlr virtual pointer](https://wayland.app/protocols/wlr-virtual-pointer-unstable-v1), [virtual keyboard](https://wayland.app/protocols/virtual-keyboard-unstable-v1), [ext-image-copy-capture](https://wayland.app/protocols/ext-image-copy-capture-v1), [xdg-desktop-portal-wlr](https://github.com/emersion/xdg-desktop-portal-wlr)
- X11: [XTEST](https://www.x.org/releases/current/doc/xextproto/xtest.html), [Xvfb(1)](https://www.x.org/releases/current/doc/man/man1/Xvfb.1.xhtml)
- Electron Forge makers: [overview](https://www.electronforge.io/config/makers), [deb](https://www.electronforge.io/config/makers/deb), [rpm](https://www.electronforge.io/config/makers/rpm), [flatpak](https://www.electronforge.io/config/makers/flatpak), [@reforged/maker-appimage](https://github.com/SpacingBat3/ReForged)
- Electron: [autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater), [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [Tray](https://www.electronjs.org/docs/latest/api/tray), [globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut), [dialog](https://www.electronjs.org/docs/latest/api/dialog), [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)
- AppImage: [spec](https://github.com/AppImage/AppImageSpec/blob/master/draft.md), [updates](https://docs.appimage.org/packaging-guide/optional/updates.html), [type2 runtime](https://github.com/AppImage/type2-runtime)
- Flatpak: [sandbox permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html), [Flathub requirements](https://docs.flathub.org/docs/for-app-authors/requirements)
- Containers and VMs: [podman-run](https://docs.podman.io/en/latest/markdown/podman-run.1.html), [QEMU invocation](https://www.qemu.org/docs/master/system/invocation.html), [libvirt URIs](https://libvirt.org/uri.html)
- Testing: [python-dbusmock](https://github.com/martinpitt/python-dbusmock), [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- Rust crates: [atspi](https://docs.rs/atspi), [ashpd](https://docs.rs/ashpd), [reis](https://docs.rs/reis), [x11rb](https://docs.rs/x11rb), [pipewire-rs](https://gitlab.freedesktop.org/pipewire/pipewire-rs)
