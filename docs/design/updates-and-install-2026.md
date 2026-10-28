# Updates and install (2026)

Status: proposal (docs only), 2026-10-28. Nothing here changes code.

The owner asked for two things: Psyche should update itself, and installing it should be as simple as possible. This doc covers both for macOS, with a short note on Windows and Linux. It ends with a PR-sized plan and the decisions only the owner can make.

**Recommendation in three lines**
1. Keep the updater we already have: Electron's `autoUpdater` (Squirrel.Mac) behind our own Ed25519-signed manifest. Update the whole `Psyche.app` as one unit, with the Gateway and the helper inside it. Don't adopt Sparkle and don't build a separate Gateway updater.
2. What's missing is mostly not updater code. Psyche needs an Apple Developer ID, notarization and a release key (none of them exist yet, so the updater is off today). On top of that, the update flow needs four pieces: stop the Gateway before the swap, take a snapshot before migrating, roll back after a failed launch, and show a "Restart to update" UI that never interrupts a task.
3. For install: a notarized, stapled DMG, then drag to Applications, then open. The app registers the Gateway with `SMAppService` (no scripts), and onboarding asks for permissions only when a feature needs them. Homebrew is the second option. No `curl | sh`.

---

## 1. Where things stand today

From the code on `main` at `20190a17`:

| Piece | Today | Where |
| --- | --- | --- |
| Build | `pnpm app:build`: psyched (official Node 24 runtime, SHA-256 checked, plus an esbuild bundle and native addons) → `PsycheHelper.app` → `Psyche.app` (electron-forge 8, Electron 44) → DMG | `deploy/macos/build-local.sh`, `deploy/scripts/build-psyched.mjs`, `deploy/macos/build-helper.sh`, `apps/desktop/forge.config.ts`, `deploy/macos/make-dmg.sh` |
| Local install | `pnpm app:install` quits the app, boots out the agent, **wipes all data unless `--keep-data`**, swaps the bundle (copy beside it, then rename), verifies the signature and launches | `deploy/macos/install-local.sh` |
| Bundle layout | `Contents/Resources/psyched/` (Gateway plus its own Node), `Contents/Resources/PsycheHelper.app` (Swift, `com.psyche.helper`), the LaunchAgent template | `apps/desktop/src/packaging/bundle-resources.ts` |
| Fuses | `RunAsNode` off, asar integrity on, `OnlyLoadAppFromAsar` on | `forge.config.ts` |
| LaunchAgent | The desktop writes `~/Library/LaunchAgents/com.psyche.gateway.plist` from the template (`{{PSYCHED}}`, `{{PSYCHE_HOME}}`, plus `PSYCHE_VAULT_KEY_FILE`), runs `launchctl bootstrap`/`kickstart`, then waits for `/healthz`. It rewrites the plist only when its **content** changes. "Quit entirely" boots the agent out and removes the plist. | `apps/desktop/src/main/supervisor.ts` |
| Signing | Ad-hoc by default. Developer ID with hardened runtime and notarization switch on when the env vars are set. The local build picks up an `Apple Development` identity if one exists. | `apps/desktop/src/packaging/signing-config.ts`, `apps/desktop/docs/signing.md` |
| Notarization | Wired up (forge for the app; `make-dmg.sh` signs, notarizes and staples the DMG), but **never run**: the repo has no signing secrets. The only release, `v0.3.0-alpha.0`, is ad-hoc signed and arm64 only. | `.github/workflows/release.yml` `dmg` job |
| Updater | Implemented, but **off**. It checks once at startup: it fetches `update-manifest.json` and `.sig` from `releases/latest/download/`, verifies Ed25519 against `TRUSTED_RELEASE_KEYS`, refuses downgrades and other hosts, and checks the zip's SHA-256 and size. It then gives the verified zip to Squirrel through a loopback feed, and the update installs on the next quit. It's off for two reasons: `TRUSTED_RELEASE_KEYS` is empty, and the updater runs only on Developer ID builds. | `apps/desktop/src/main/updater.ts`, `update-flow.ts`, `update-manifest.ts`, `release-keys.ts` |
| Release pipeline | On a `v*` tag: Docker image, sandbox images, CLI binaries, DMG and `Psyche-<v>-darwin-<arch>.zip` per arch, a signed manifest when `RELEASE_SIGNING_KEY` exists, the GitHub Release, and the Homebrew tap when a token exists. Every signing step skips cleanly without its secret. A `release` environment exists. | `.github/workflows/release.yml`, `deploy/scripts/update-manifest.mjs` |
| Homebrew | A cask and a CLI formula exist as templates. The tap repo and token aren't set up. | `deploy/homebrew/` |
| Data | `~/.psyche`. Gateway DB migrations run forward-only at boot (41 files in `packages/db/migrations`, plus connectors and notifications). `psyche migrate --check` and `psyche backup` (age-encrypted) exist. The upgrade guide asks for a manual backup first. | `packages/db/src/migrate.ts`, `docs/guides/upgrade.md` |
| Handshake | `connect` negotiates `protocolVersion` (now `1`, a range). It doesn't report the Gateway's **build** version. | `packages/protocol/src/methods/connect.ts`, `version.ts` |
| Size budgets | psyched 205 MB, app 530 MB, DMG 150 MB (the DMG is about 143 MB) | `deploy/size-budget.json` |

**Gaps this doc closes**

- **G1. No Gateway restart.** Squirrel swaps the bundle in place at the same path, so the next launch sees an unchanged plist. The supervisor then takes the `loaded && !changed && healthy` branch. The **old** psyched keeps running, now on top of replaced files, and any module it loads lazily comes from the new build.
- **G2. No snapshot before migrations.** The next boot migrates `~/.psyche` forward, and you can't undo that without a backup the user may not have made.
- **G3. No rollback.** ShipIt deletes the old bundle, and if the new version fails to start, nothing is left to go back to.
- **G4. No UX.** The updater checks once per launch, gives no "Restart to update", shows no release notes and has no channels. It doesn't respect running tasks or quiet hours, and nothing implements the `updates.check` setting that security §14 promises.
- **G5. Nothing is signed or notarized.** There's no Developer ID, no notarization and no release key, which also keeps the updater off. Gatekeeper blocks the downloaded DMG.
- **G6. The install path is script-shaped.** The LaunchAgent is a plist that the app writes into `~/Library/LaunchAgents`, and the documented install path is a repo script that also wipes data.

---

## 2. Auto-update

### 2.1 Choosing an updater

| | **Squirrel.Mac** (Electron `autoUpdater`) | **Sparkle 2** | **Custom Gateway updater** |
| --- | --- | --- | --- |
| Already in the app | Yes: the manifest verification, the loopback feed and the release job all exist | No. It's a native framework, so it needs a native addon or a Swift shim in Electron's main process | No |
| What gets replaced | The whole `.app`, atomically (ShipIt swaps the bundle after quit) | The whole `.app`, atomically (XPC installer) | Only `Resources/psyched`. That **breaks the bundle's code seal** (`codesign --verify --deep --strict` fails, Gatekeeper and TCC treat the app as damaged) unless the Gateway moves outside the bundle |
| Signature checks | Ours (Ed25519 manifest, SHA-256) **plus** Squirrel's check that the new bundle satisfies the running app's designated requirement | EdDSA on the appcast and the archive, plus a code-sign check | All of it would be ours |
| Deltas | No | Yes (binary deltas per pair of versions) | Possible for the Gateway alone |
| UI | None built in. We draw our own, which we want anyway: in-app, quiet-hours aware, task aware | Its own standard window (fine for a utility app, foreign in ours) | Ours |
| Non-admin users | Fails if the user can't write to `/Applications/Psyche.app` | Asks for an admin password through its installer | Writes under `~` |
| Used by | VS Code, Slack, Discord, Claude Desktop, most Electron apps | Most native Mac apps | — |

**Recommendation: Squirrel.Mac, behind our manifest.** It is already built and reviewed (security §11). It updates the app, the Gateway and the helper as one signed, sealed unit. It also checks the designated requirement, which is the property that keeps TCC grants. Sparkle's real advantage is deltas, and at our size and release rate that doesn't justify a second native stack in the main process (section 2.4). A custom Gateway updater would mean either breaking the seal or moving the Gateway out of the bundle, which would give us two artifacts to keep in lockstep. The owner chose to keep a separate Node runtime for RAM reasons, and that doesn't require a separate update path: the runtime can stay a separate *process* inside one *bundle*.

**Escape hatch.** The manifest format stays updater-neutral (artifacts plus hashes). If the release rate climbs to weekly and download size becomes a complaint, revisit Sparkle for deltas then, without touching the release key or the manifest.

### 2.2 The update, step by step

```
check ─► verify manifest ─► download zip + verify hash ─► Squirrel stages it
   │                                                         │
   │                                     "Restart to update" (or auto at idle, §2.6)
   │                                                         ▼
   │              wait: no running agent task, no unsent text, no live approval
   │                                                         ▼
   │              1. keep previous app (APFS clone, §2.5)
   │              2. Gateway: drain → launchctl bootout   (G1)
   │              3. helper: quit
   │              4. autoUpdater.quitAndInstall()  → ShipIt swaps the bundle
   ▼                                                         ▼
 next check            new app launches → supervisor sees build mismatch → bootstrap
                       new psyched boots → pending migrations? snapshot first (§2.7) → migrate
                       new app marks the launch good after health + handshake (§2.5)
```

**The app.** Squirrel replaces `/Applications/Psyche.app` atomically after the app quits. Everything inside it (Electron, `app.asar`, psyched, its Node runtime, the helper) changes together. A bundle that is half one version and half another can't happen.

**The Gateway (fixes G1).** Before `quitAndInstall`, the desktop calls a new admin RPC, `gateway.prepareUpdate`. The Gateway stops accepting new runs, finishes or checkpoints the current turn (tasks already resume after a restart), flushes its writers and answers `ready`. The desktop then runs `launchctl bootout gui/<uid>/com.psyche.gateway`, so `KeepAlive` can't restart the old binary while ShipIt swaps the files. On the next launch, the supervisor compares the build of the running Gateway (from the handshake, section 2.10) with `Resources/psyched/build-info.json`. On a mismatch it runs `launchctl kickstart -k`. The plist itself stays the same under SMAppService (section 3.2), because it refers to the program by a bundle-relative path. Also add the build to the plist's `EnvironmentVariables` (`PSYCHE_BUILD`). The content check then works even for the script-installed agent, and it covers the case where the app updates while the desktop is closed but the agent is still loaded.

**The helper.** It's quit before the swap (the helper launcher already knows its PID) and relaunched by the new app. Its bundle id (`com.psyche.helper`), its path inside the bundle, its team and its designated requirement all stay the same, so its TCC grants carry over (section 2.9).

**Updates that land while the desktop is closed.** Squirrel only installs when the app quits. With "close window" the Gateway keeps running, and the desktop process normally stays alive in the menu bar, so the flow above covers it. If the owner chose "Quit entirely", the agent is already gone.

### 2.3 Signing, notarization and checks

Every release passes four checks before the updater installs it:
1. **Manifest:** Ed25519 over the exact bytes, by a key embedded in the app (exists). The private key lives offline and in the GitHub environment `release` with required reviewers (exists in the workflow; the key itself doesn't exist yet).
2. **Artifact:** SHA-256 and size, streamed before anything is kept (exists).
3. **Code signature:** Squirrel checks that the new bundle satisfies the running app's designated requirement, which is `identifier "com.psyche.desktop" and anchor apple generic and certificate leaf[subject.OU] = "<TEAMID>"` (exists, once Developer ID signed).
4. **Notarization:** the zip contains the stapled app (add `xcrun stapler validate` on the app before zipping, section 4). Gatekeeper then accepts it offline too.

The updater also runs only when the running app itself is Developer ID signed (exists). Ad-hoc builds never update themselves, so dev builds stay manual.

### 2.4 Delta versus full downloads

Full zips only, for now.

- The DMG is about 143 MB, and the zip is about the same size (both are compressed copies of the same about 443 MiB bundle). On a 50 Mbit/s line that's under 30 s, downloaded in the background.
- Most of the bytes are Electron's framework and the Node runtime, which change only on an Electron or Node bump. Most releases change `app.asar` and `psyched/app/`. A delta would usually be small, but Squirrel can't apply one.
- Measure first: add `bytes` per component to `build-info.json` and log the download time in `updater.json`. Revisit only if releases become weekly *and* someone complains. The options then are Sparkle's deltas (section 2.1) or a second "app-only" zip whose `requires` field names the Electron and Node versions it can sit on, still swapped as a whole bundle by a small Swift step. Don't build that until it's needed.
- Budget: keep the zip under `dmgMB` (150), and fail the release job above it like the DMG check (section 4).

### 2.5 Rollback after a failed launch (fixes G3)

Squirrel has no rollback, so add one around it.

1. **Before the swap**, the desktop clones the current bundle to `~/Library/Application Support/Psyche/previous/Psyche.app` with `cp -c` (an APFS clone, nearly free on disk until files differ) and writes `previous.json` with the version and build. It keeps only one previous version.
2. **The launch probation.** The new app writes `run/launch.json` (`{version, attempts, startedAt}`) before anything else. It marks the launch **good** when the Gateway answers `/healthz`, the `connect` handshake agrees on the build, and the main window has rendered. When that happens it clears `attempts`.
3. **On failure**, meaning two launches in a row without reaching good, or a Gateway that crash-loops on the new build (`launchctl print` shows the last exit code), the app shows a plain "Psyche 0.5.0 didn't start. Go back to 0.4.2?" screen. It works from the splash, with no Gateway needed. "Go back" boots the agent out, restores the pre-update snapshot of `~/.psyche` (section 2.7), swaps the cloned bundle back with a rename and relaunches. It also records the bad build in `run/skip-builds.json` so the updater doesn't offer it again. The skipped version is offered again only when a newer release appears.
4. **Downgrade rules** stay as they are: the manifest never offers an older version. Rollback is a local restore, not a download.
5. **Required updates** (`minimumVersion`): a rollback below the minimum is still allowed, because a working older app beats a broken newer one. It shows the "update required" banner until a fixed release ships.

Why not roll back automatically? Restoring data throws away anything written after the snapshot, which on a failed launch is almost nothing, but it's the owner's data. One click is the right price.

### 2.6 Update UX (fixes G4)

**Checking.** At launch (after the window shows), then every 6 h with up to 30 min of jitter, and on wake from sleep (`powerMonitor` `resume`). Never more than once an hour. All of it stops when `updates.check` is false (the setting security §14 promises; add it). The request carries nothing beyond what GitHub sees for a static download.

**Downloading.** Automatic and in the background, at low priority. A metered connection (macOS Low Data Mode, which `NWPathMonitor` exposes through the helper) waits for an unmetered one unless the update is required.

**Installing.** The update is staged, and the app then shows:
- a quiet **"Restart to update · What's new"** row at the top of Settings › About and in the tray menu, plus a small dot on the tray icon;
- a one-time notification, held until quiet hours end (`notifications.quietHours`);
- for a **required** update (below `minimumVersion`): a banner in every window that can't be dismissed, still subject to the rules below.

**Never in the middle of work.** "Restart to update" and the automatic install both wait while any of these holds:
- an agent task or chat run is running, or a run is waiting on an approval card;
- a text field holds unsent text (`HAS_UNSENT_TEXT` already exists for the renderer release);
- dictation, a screen-ask panel, a browser takeover or a terminal session is active.

When the owner clicks Restart during one of these, the app says what it's waiting for, with a "Restart anyway" button. It never kills a run silently. A running task is checkpointed by `gateway.prepareUpdate` and resumes after the restart.

**Automatic install (on by default).** "Install updates automatically" applies a staged update when Psyche has been idle for 15 min with nothing from the list above. It prefers quiet hours, or 03:00–05:00 local time when quiet hours aren't set, so the owner usually never sees a restart. The window comes back where it was (window placement already persists).

**Settings › About › Updates:** current version and channel, last checked, "Check now", "Install updates automatically", channel (section 2.8), the release notes of the current and staged versions, and "Go back to <previous>" while a previous bundle is kept.

### 2.7 `~/.psyche` migrations with a backup (fixes G2)

The Gateway already migrates at boot. Add a snapshot step in front of that, inside the Gateway, so it covers the desktop, the CLI and Docker in the same way.

1. At boot, compare the applied migrations with the bundled ones (`listMigrationFiles`, already used by `migrate --check`). With none pending, skip the snapshot.
2. With some pending, write `~/.psyche/backups/pre-update/<fromVersion>-to-<toVersion>-<time>/` (0700, files 0600) before migrating. It holds every SQLite database (`state/psyche.sqlite`, the connectors and notifications databases), copied with the SQLite online backup API (better-sqlite3 `db.backup()`), so the copy is consistent even under WAL. It also holds `vault/vault.db` as is (already encrypted), `config.json`, and a `manifest.json` with checksums.
3. Migrate. On a failure, restore the snapshot in place and exit with a clear code. The desktop shows that code on the splash and offers "Go back" (section 2.5).
4. Keep the last **two** pre-update snapshots, and delete one only after a launch of the next version is marked good and 14 days have passed. Disk is cheaper than RAM for this owner.
5. `workspace/`, `library/` and `browser/` aren't migrated and aren't copied: they're large, and their formats don't change between versions. If a migration ever needs to touch them, it declares that in its header and the snapshot includes the folder.
6. The snapshot isn't encrypted beyond what the files already are (the vault is SQLCipher; `state/` relies on FileVault, as today). That's the same exposure as the live files right next to it. It isn't a portable backup, and `psyche backup` (age) remains the real one. The upgrade guide keeps recommending a real backup before major versions.
7. Revocations still replay after a restore (`security/revocations.jsonl`, never snapshotted), so going back can't undo a revoked device or grant.

`config.json` keys a newer version rejects are already caught at boot. Add the same check for **newer** keys an **older** version doesn't know, so that a rollback starts cleanly: unknown keys are ignored with a warning, never fatal.

### 2.8 Channels

- **stable** (default): releases without a prerelease tag.
- **beta** (opt-in in Settings): `-beta.N` and `-rc.N`. Alpha builds stay manual, never offered automatically.

`releases/latest/download/` only ever points at the newest non-prerelease, so channels need their own pointer on the same pinned host. Add a rolling GitHub release, tag `update-feed`, whose assets the release job overwrites: `stable.json`, `beta.json` and their `.sig`. Each is the signed manifest of the newest release in that channel. The updater's feed becomes `…/releases/download/update-feed/<channel>.json`, which is still under the pinned `github.com/devmello/psyche/releases/download/`. A stable release updates both files, so beta users get it too. Add `channel` to the signed manifest, and refuse a manifest whose channel the user hasn't chosen.

Moving from beta back to stable doesn't downgrade. The app stays on the beta version until stable passes it.

### 2.9 Keeping TCC grants across updates

macOS ties a grant to the app's code requirement, not to its path or version. Grants survive an update as long as these never change:

| Must stay the same | Value |
| --- | --- |
| Bundle ids | `com.psyche.desktop`, `com.psyche.helper` (and Electron's `com.psyche.desktop.helper*`) |
| Team ID | the Developer ID team, chosen once (owner decision D1) |
| Designated requirement | the default `identifier … and anchor apple generic and certificate leaf[subject.OU] = TEAMID`. Don't customise it per build, and never sign with a different certificate type |
| Helper location | `Contents/Resources/PsycheHelper.app` (TCC attributes the helper's requests to the outer app, #570) |
| Entitlements and usage strings | add keys, never remove ones a grant relies on |

Then a CI check fails the release if the DR of the built app or helper differs from `deploy/macos/designated-requirements.txt`. The first Developer ID build is a one-time break for everyone on an ad-hoc build. That's only the owner today, and it's the `tccutil reset` that `install-local.sh` already prints.

### 2.10 Gateway/desktop version handshake

`protocolVersion` already covers compatibility. Add **identity**:

- `ConnectChallenge` gains `server: {version, build, commit}` (from `build-info.json`). It's additive, so no protocol bump.
- The **bundled** Gateway must match the desktop's own build exactly. On a mismatch, the supervisor restarts the agent (section 2.2). A mismatch that persists after the restart means the plist points elsewhere: show the existing "Another copy of Psyche runs the Gateway" screen.
- An **external** Gateway (Docker or server mode) only needs an overlapping protocol range. When it's older than the desktop's minimum, the desktop shows "Your Gateway (0.4.0) is older than this app supports; update it" and links the upgrade guide. It never offers to update a remote host.
- The helper reports its build in its pairing hello the same way. A mismatch means it's an old helper that's still running, so the launcher restarts it.

### 2.11 Release notes in the app

- Add `notes` to the signed manifest: short Markdown, about 2 KB at most, taken from `docs/release-notes/<minor>.md` or the changesets changelog for that version. It's signed, so a release can't be rewritten after the fact. It's still rendered with the chat's sanitising Markdown renderer, with links opening externally.
- Show it in the "Restart to update" row ("What's new"), and once after the update as a dismissible card at the top of the main window. The full notes link to the GitHub release page.

---

## 3. The simplest install

**Goal:** download the DMG, drag Psyche to Applications, open it. Onboarding does the rest, with no Terminal, no scripts and no "unidentified developer" dialog.

### 3.1 Developer ID, notarization and stapling

- Sign the app, the nested helper, the Node runtime and every `.node` file with **Developer ID Application**, hardened runtime and a secure timestamp. Do this inside out, as forge and `bundle-resources.ts` already do. psyched's Node keeps only the entitlements it needs: `com.apple.security.cs.allow-jit` for V8. Skip `disable-library-validation` if the bundled addons are signed by the same team.
- Notarize the **app** (forge, `notarytool`), then **staple** it, and only then zip it for the updater and put it in the DMG. After that, sign, notarize and staple the **DMG** too (`make-dmg.sh` already does this when the secrets exist).
- Result: the first open is a single "Psyche is an app downloaded from the internet. Open?" prompt, which also works offline because of the stapled ticket.

### 3.2 `SMAppService` for the Gateway agent

Today the app writes a plist into `~/Library/LaunchAgents` and drives `launchctl`. On macOS 13+ (we require Sequoia, macOS 15), the supported way is `SMAppService.agent(plistName:)`:

- Ship `Contents/Library/LaunchAgents/com.psyche.gateway.plist` inside the signed bundle, with `BundleProgram` = `Contents/Resources/psyched/psyched` (bundle-relative), `KeepAlive`, `RunAtLoad` and `AssociatedBundleIdentifiers` = `com.psyche.desktop`.
- Register it from the main process. Electron supports this directly with `app.setLoginItemSettings({ openAtLogin: true, type: "agentService", serviceName: "com.psyche.gateway.plist" })`, and `getLoginItemSettings` returns its status (`enabled`, `requires-approval`, `not-registered`, `not-found`). No native addon is needed.
- **What we gain:**
  - Updates need no plist rewrite, because the path is relative to the bundle and the bundle is swapped in place.
  - Login Items shows "Psyche" with our icon instead of an anonymous "node".
  - A moved app keeps working.
  - Deleting the app stops the agent.
  - "Quit entirely" becomes `unregister`.
- **What changes:** the plist is static and sealed in the bundle, so it can't carry `{{PSYCHE_HOME}}` or `PSYCHE_VAULT_KEY_FILE`. psyched therefore defaults to `~/.psyche` (it does already) and reads the key-file path from `~/.psyche/config.json` or the conventional `secrets/` location. Logs go to `$PSYCHE_HOME/logs` from psyched itself, not through `StandardOutPath` (launchd doesn't expand `~`). A custom `PSYCHE_HOME` remains a **dev-only** path that keeps today's script mode (`supervisor.ts` keeps both code paths behind one interface).
- **User approval:** if the owner turns Psyche off in System Settings › Login Items, the status reads `requires-approval`. The app then shows "Psyche's background service is off" with a button that opens that pane (`SMAppService.openSystemSettingsLoginItems()` through the helper, or `x-apple.systempreferences:com.apple.LoginItems-Settings.extension`).
- **Migration:** on first launch of the SMAppService build, boot out and delete the old `~/Library/LaunchAgents/com.psyche.gateway.plist` if it points into this bundle (the existing takeover logic covers one that points elsewhere), then register.

### 3.3 First launch and onboarding

Onboarding is being built in parallel. These are the install-side hooks it should call, in order, without adding any steps of its own:

1. **Location check.** If the app runs from the DMG or a translocated path (`isTranslocated` exists), offer "Move to Applications" (`app.moveToApplicationsFolder()`, which handles the copy, quarantine and relaunch). Today the user only gets an error message.
2. **Background service.** Register the agent (section 3.2), show the existing splash while `/healthz` comes up, and handle `requires-approval`.
3. **Admin bootstrap and the vault** (already done: `bootstrap-admin.ts`, key-file slot).
4. **Permissions, in a sequence and only when needed.** Onboarding asks only for what the first-run experience uses:
   - Notifications, with an explanation first;
   - Microphone and Speech, only if the owner turns on dictation in onboarding.

   Accessibility, Screen Recording, Automation (per target app), Calendar, Contacts and Reminders are asked for **at first use**, from the feature, with the existing permission cards. Every prompt is preceded by our own one-line explanation, so the system dialog is never a surprise, and a denial is recoverable with an "Open System Settings" button.
5. **Updates.** A final onboarding line: "Psyche updates itself in the background and never restarts during a task," with the automatic install switch (default on).

### 3.4 Homebrew, and why not `curl | sh`

- **Homebrew cask** (exists as a template): set up `devmello/homebrew-psyche` with a fine-grained token, and add `auto_updates true` so that `brew upgrade` doesn't fight the in-app updater. Extend `zap` with the helper's paths (`~/Library/Preferences/com.psyche.helper.plist`, `~/Library/Caches/com.psyche.helper`, `~/Library/Application Support/com.psyche.helper`, the saved states) so it matches `install-local.sh`. Later, submit to the main `homebrew/cask` once the release cadence is stable, so the command becomes `brew install --cask psyche`.
- **`curl | sh`:** don't. It adds a second trust path (a script on a web host) to protect, and gains nothing over the cask or the DMG for a GUI app. The CLI already has a Homebrew formula and single-file binaries.

### 3.5 Uninstall

Add **Settings › About › Uninstall Psyche…** with a single, honest sheet:
- **Always:** unregister the agent and stop the helper. Remove `~/Library/Application Support/Psyche` and the helper's equivalent, caches, logs, preferences, saved state, `HTTPStorages` and WebKit data (the same list `install-local.sh` uses). Then move `Psyche.app` to the Trash. Moving it to the Trash isn't permanent deletion.
- **Checkbox, off by default:** "Also delete my Psyche data (~/.psyche: chats, memory, vault, backups)". Above it, a "Back up first" button that runs `psyche backup`. The Keychain items (`com.psyche.vault`, `com.psyche.helper.*`) go with the data, because without the data they're useless.
- **Checkbox, on:** "Reset privacy permissions", which runs `tccutil reset All com.psyche.desktop` and `… com.psyche.helper` (both run as the user).
- Document the same steps in `docs/guides/install.md` for an app that won't launch, and keep `brew uninstall --zap` in step.

---

## 4. Release pipeline

`release.yml` already has most of this. The changes:

| Step | Runner | Status → change |
| --- | --- | --- |
| Version | ubuntu | Exists (changesets). Map the semver prerelease to a channel: none → stable, `beta`/`rc` → beta, `alpha` → none |
| Build psyched + helper + app | `macos-26` (arm64), `macos-15-intel` (x64) | Exists. Stamp `CFBundleVersion` = `<run number>` (monotonic) next to the semver `CFBundleShortVersionString` |
| Sign + notarize + **staple** app | same | Forge signs and notarizes. Add `xcrun stapler staple` and `validate` on the app **before** zipping |
| Zip (updater) + DMG | same | Exists. Zip after stapling, then sign, notarize and staple the DMG |
| Checks | same | Add: `codesign --verify --deep --strict`, `spctl -a -vvv -t exec` = "Notarized Developer ID", `stapler validate` for app and DMG, the DR matches `designated-requirements.txt`, fuses (`npx @electron/fuses read`), and size: zip and DMG ≤ `dmgMB`, app ≤ `appMB`, psyched ≤ `psychedMB` (already enforced at build) |
| **Smoke test** | fresh `macos-26` job | New. Download the DMG artifact, mount it, copy the app to `/Applications`, run `Psyche.app/Contents/Resources/psyched/psyched --bundle-check`, then start psyched with a temp `PSYCHE_HOME` and wait for `/healthz`. Then the **upgrade path**: run `deploy/scripts/upgrade-roundtrip.mjs` against the previous release's psyched (downloaded from its release) and the new one, which proves the migrations and the pre-update snapshot on real data. A full GUI auto-update run (N-1 app updating itself to N) needs a test feed on the pinned host, so do it as a manual pre-stable checklist item, not in CI |
| Manifest | ubuntu, env `release` | Exists. Add `channel`, `notes` and `build`. Publish to the release **and** overwrite `update-feed/<channel>.json` + `.sig` |
| GitHub Release | ubuntu | Exists |
| Homebrew | ubuntu | Exists (skips without a token). Add `auto_updates true` |

**Version scheme:** semver, managed by changesets, with `0.x` until 1.0 (a minor may break). Prereleases are `-alpha.N`, `-beta.N` and `-rc.N`. One version covers the app, psyched, the CLI and the images. The build number is the workflow run number. Security releases raise `deploy/update-policy.json` `minimumVersion` in the same PR as the fix.

**Secrets** (all already named in `release.yml`): `MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY`, `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `RELEASE_SIGNING_KEY` (environment `release`, required reviewer = owner) and `HOMEBREW_TAP_TOKEN`.

---

## 5. Windows and Linux, later

Keep the same shape: one signed bundle per platform, the same Ed25519 manifest with `platform` widened, the Gateway as a supervised background process, and the snapshot before migrating in the Gateway (it's already cross-platform). See [cross-platform-2026.md](cross-platform-2026.md).

- **Windows.** Use electron-builder NSIS plus `electron-updater`, or MSIX. Prefer NSIS per-user (no admin rights, deltas via blockmap), still behind our manifest. Sign with Azure Trusted Signing, which is cheap and avoids an EV token. The Gateway runs as a per-user Scheduled Task at logon, or a `Run` key, not a service, to stay per-user like the LaunchAgent. The helper is C# and ships inside the install folder under the same rules: a stable publisher and stable paths, so Windows privacy prompts keep their answers.
- **Linux.** AppImage with an embedded zsync update (deltas for free), plus a `.deb`/`.rpm` from a signed apt/dnf repo for people who prefer that. The Gateway uses the existing `systemd --user` unit (`deploy/systemd`). No helper equivalent yet.

---

## 6. Plan

Each step is one PR, in order. Steps 1–3 need nothing from Apple. Steps 4 onwards need the owner's accounts (section 7).

| # | PR | What | Needs |
| --- | --- | --- | --- |
| 1 | **Gateway build in the handshake** | `server` in `ConnectChallenge`. The supervisor restarts the agent on a build mismatch. `PSYCHE_BUILD` in the plist env. Fixes G1 for local installs too | — |
| 2 | **Pre-update snapshot** | The snapshot before pending migrations, restore on a failed migration, retention, the tolerant check for unknown `config.json` keys. Extend `upgrade-roundtrip.mjs` | — |
| 3 | **`gateway.prepareUpdate`** | Drain, checkpoint, then `ready`. Add "is anything busy?" for the UI (running tasks, pending approvals) | — |
| 4 | **Owner: accounts and keys** | Apple Developer Program, the Developer ID cert, an App Store Connect API key, the release key (`update-manifest.mjs keygen`), GitHub secrets and the `release` reviewers | owner |
| 5 | **Release key + stapling + checks** | The public key in `release-keys.ts`. Staple before zipping. Add the `spctl`/stapler/DR/fuse/size checks to `release.yml`. Cut `0.4.0-beta.1` signed and notarized. The owner reinstalls once by hand (the last manual install) | 4 |
| 6 | **Update flow** | Periodic, wake-time and jittered checks. `updates.check`. Background download. The apply sequence (clone previous → prepareUpdate → bootout → quit helper → `quitAndInstall`). The busy gates | 1, 3, 5 |
| 7 | **Update UI** | Settings › About › Updates, the tray row, the quiet-hours notification, the required-update banner, the automatic install at idle | 6 |
| 8 | **Rollback** | Launch probation, the "Go back" screen on the splash, `skip-builds.json` | 2, 6 |
| 9 | **Channels + notes** | `update-feed` rolling release, `channel`/`notes`/`build` in the manifest, the channel picker, "What's new" | 6 |
| 10 | **SMAppService** | The bundled agent plist, `setLoginItemSettings({type: "agentService"})`, the `requires-approval` UI, migration from the old plist. Script mode stays for a dev `PSYCHE_HOME` | 5 (needs a stable signature to test meaningfully) |
| 11 | **First-run install hooks** | Move to Applications. Hand off to onboarding (coordinate with the onboarding session; no permission prompts outside it) | 10 |
| 12 | **Uninstall + Homebrew** | The uninstall sheet. The cask gets `auto_updates true` and the full `zap`. The tap repo goes live. `install.md` rewritten around the DMG | 5 |
| 13 | **CI smoke test** | The fresh-runner DMG install, `--bundle-check`, the N-1 → N roundtrip | 5 |

`install-local.sh` stays as the developer path. Make `--keep-data` the default and the wipe an explicit `--reset`, because people will run it against a real install once updates exist.

### Risks

| Risk | Mitigation |
| --- | --- |
| A team ID change (for example individual → organization later) breaks auto-update and every TCC grant: Squirrel refuses a different DR | Decide D1 once, before the first signed release. A switch later means one manual reinstall per user, announced in the release notes |
| The release key is lost or leaks | Offline copy in a password manager, plus the `release` environment with required reviewers. Rotation is already specified (security §11). Raise `minimumVersion` on a leak |
| A migration bug corrupts data | A pre-update snapshot of every database, restore on failure, the CI roundtrip on real N-1 data, "Go back" |
| Squirrel fails for non-admin accounts (can't write to `/Applications`) | Detect it (`access` W_OK on the bundle's parent). Show "Download the update" linking the DMG, the same check-and-notify flow without the install |
| An update interrupts work | The busy gates. `prepareUpdate` checkpoints. A restart is never forced while a task runs, even for required updates |
| Notarization flakes or stalls in CI | `notarytool --wait --timeout 30m`, one retry. Notarization runs before the zip, so a failure publishes nothing |
| The Intel runner keeps breaking the helper (Swift 6) | Owner decision D4 |
| The SMAppService move breaks a custom `PSYCHE_HOME` | Keep script mode for dev, and document that the packaged app always uses `~/.psyche` |
| A clone of the previous bundle on a non-APFS volume costs a full 443 MiB | Only `/Applications` on the system volume is supported. Skip the clone (and say "Go back unavailable") elsewhere |

---

## 7. What the owner needs to do or decide

**Accounts and one-time actions**

1. **Join the Apple Developer Program** ($99 a year). This is needed for Developer ID signing and notarization, and the updater turns on only with them.
2. **Create a "Developer ID Application" certificate** in Xcode or on developer.apple.com. Export it as `.p12` with a password, then set `MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD` and `MACOS_SIGNING_IDENTITY` in GitHub.
3. **Create an App Store Connect API key** (role: Developer) for `notarytool`. Set `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
4. **Generate the release key** offline with `node deploy/scripts/update-manifest.mjs keygen`. Keep the private half in your password manager and in `RELEASE_SIGNING_KEY` (environment `release`, with you as the required reviewer). The public half goes into the PR in step 5.
5. **Create the tap repo** `devmello/homebrew-psyche` and a fine-grained `HOMEBREW_TAP_TOKEN` (contents: write on that repo only).
6. **Reinstall by hand once** when the first Developer ID build ships, then run `tccutil reset All com.psyche.desktop && tccutil reset All com.psyche.helper` and grant permissions again. After that, updates keep the grants.

**Decisions, each with a recommendation**

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Individual or organization Apple account (the name Gatekeeper shows, and a team ID you can never change without breaking updates) | **Individual**, unless you expect to put Psyche under an organization within a year. An organization needs a D-U-N-S number and takes weeks. Either way, pick once |
| D2 | Updater | **Squirrel.Mac behind our manifest** (section 2.1) |
| D3 | Install updates automatically by default | **On**: only when idle, never during a task, preferring quiet hours |
| D4 | Intel Macs | **Ship arm64 only from 0.4** and drop the x64 DMG job, unless you know of Intel users. It halves the release time, and the Intel toolchain keeps breaking the helper |
| D5 | Channels | **stable + beta**. Alpha stays manual |
| D6 | Deltas | **Not now**. Measure first (section 2.4) |
| D7 | SMAppService, and a packaged `PSYCHE_HOME` that is always `~/.psyche` | **Yes** |
| D8 | Rollback | **One click** after a failed launch, not automatic |
| D9 | `curl \| sh` installer | **No**. The DMG and the Homebrew cask are enough |
| D10 | Submit to the main `homebrew/cask` | **After 1.0**. Use our own tap until then |
