# Updates and install (2026)

Status: proposal, 2026-10-28. **Amended 2026-11-05:** the owner decided not to pay for the Apple Developer Program. Releases are signed with a **self-signed code-signing certificate** that Psyche makes itself, plus Psyche's own Ed25519 release key for update manifests. There is no Developer ID, notarization, stapling or APNs. The code for this path landed with that decision (certificate script, signing config, pinned designated requirement, updater gate, release workflow). The paid path stays as an optional "later" in [Appendix A](#appendix-a-the-paid-developer-id-path-later).

The owner asked for two things: Psyche should update itself, and installing it should be as simple as possible. This doc covers both for macOS, with a short note on Windows and Linux. It ends with a PR-sized plan and the decisions only the owner can make.

**Recommendation in three lines**
1. Keep the updater we already have: Electron's `autoUpdater` (Squirrel.Mac) behind our own Ed25519-signed manifest. Update the whole `Psyche.app` as one unit, with the Gateway and the helper inside it. Don't adopt Sparkle and don't build a separate Gateway updater.
2. What's missing is mostly not updater code. Psyche needs a stable signing identity (a self-signed certificate it makes once, with the SHA-1 pinned in the repo) and a release key (neither exists yet, so the updater is off today). On top of that, the update flow needs four pieces: stop the Gateway before the swap, take a snapshot before migrating, roll back after a failed launch, and show a "Restart to update" UI that never interrupts a task.
3. For install: a signed DMG, drag to Applications, open, and approve it once under System Settings › Privacy & Security › Open Anyway (the cost of not being notarized, section 3.1). The app registers the Gateway with `SMAppService` (no scripts), and onboarding asks for permissions only when a feature needs them. Homebrew is the second option, from our own tap only. No `curl | sh`.

---

## 1. Where things stand today

From the code on `main` at `20190a17`:

| Piece | Today | Where |
| --- | --- | --- |
| Build | `pnpm app:build`: psyched (official Node 24 runtime, SHA-256 checked, plus an esbuild bundle and native addons) → `PsycheHelper.app` → `Psyche.app` (electron-forge 8, Electron 44) → DMG | `deploy/macos/build-local.sh`, `deploy/scripts/build-psyched.mjs`, `deploy/macos/build-helper.sh`, `apps/desktop/forge.config.ts`, `deploy/macos/make-dmg.sh` |
| Local install | `pnpm app:install` quits the app, boots out the agent, keeps your data (wiping is an explicit `--reset`, which lists what it deletes and asks first), swaps the bundle (copy beside it, then rename), verifies the signature and launches | `deploy/macos/install-local.sh` |
| Bundle layout | `Contents/Resources/psyched/` (Gateway plus its own Node), `Contents/Resources/PsycheHelper.app` (Swift, `com.psyche.helper`), the LaunchAgent template | `apps/desktop/src/packaging/bundle-resources.ts` |
| Fuses | `RunAsNode` off, asar integrity on, `OnlyLoadAppFromAsar` on | `forge.config.ts` |
| LaunchAgent | The desktop writes `~/Library/LaunchAgents/com.psyche.gateway.plist` from the template (`{{PSYCHED}}`, `{{PSYCHE_HOME}}`, plus `PSYCHE_VAULT_KEY_FILE`), runs `launchctl bootstrap`/`kickstart`, then waits for `/healthz`. It rewrites the plist only when its **content** changes. "Quit entirely" boots the agent out and removes the plist. | `apps/desktop/src/main/supervisor.ts` |
| Signing | Ad-hoc by default. With `PSYCHE_SIGN_IDENTITY` set: the hardened runtime, inside out (app, helper, psyched's Node, every `.node`), with Psyche's self-signed "Psyche Release" certificate (`deploy/macos/make-signing-cert.sh`) or, optionally, a Developer ID. The local build picks up a "Psyche Release" identity first, then Developer ID, then `Apple Development`. | `apps/desktop/src/packaging/signing-config.ts`, `apps/desktop/docs/signing.md` |
| Notarization | **Not used on the release path.** Forge and `make-dmg.sh` notarize and staple only a Developer ID build with Apple API credentials; with a self-signed identity they skip it and say so in the log. The only release so far, `v0.3.0-alpha.0`, is ad-hoc signed and arm64 only. | `.github/workflows/release.yml` `dmg` job |
| Updater | Implemented, but **off**. It checks once at startup: it fetches `update-manifest.json` and `.sig` from `releases/latest/download/`, verifies Ed25519 against `TRUSTED_RELEASE_KEYS`, refuses downgrades and other hosts, and checks the zip's SHA-256 and size. It then gives the verified zip to Squirrel through a loopback feed, and the update installs on the next quit. It's off for two reasons: `TRUSTED_RELEASE_KEYS` is empty, and no release certificate is pinned yet. The updater runs only when the running app's own signature satisfies the pinned designated requirement (section 2.9). | `apps/desktop/src/main/updater.ts`, `update-flow.ts`, `update-manifest.ts`, `release-keys.ts` |
| Release pipeline | On a `v*` tag: Docker image, sandbox images, CLI binaries, DMG and `Psyche-<v>-darwin-<arch>.zip` per arch, a signed manifest when `RELEASE_SIGNING_KEY` exists, the GitHub Release, and the Homebrew tap when a token exists. Every signing step skips cleanly without its secret. A `release` environment exists. | `.github/workflows/release.yml`, `deploy/scripts/update-manifest.mjs` |
| Homebrew | A cask and a CLI formula exist as templates, for our own tap only (main `homebrew/cask` needs notarization). The tap repo and token aren't set up. | `deploy/homebrew/` |
| Data | `~/.psyche`. Gateway DB migrations run forward-only at boot (41 files in `packages/db/migrations`, plus connectors and notifications). `psyche migrate --check` and `psyche backup` (age-encrypted) exist. The upgrade guide asks for a manual backup first. | `packages/db/src/migrate.ts`, `docs/guides/upgrade.md` |
| Handshake | `connect` negotiates `protocolVersion` (now `1`, a range). It doesn't report the Gateway's **build** version. | `packages/protocol/src/methods/connect.ts`, `version.ts` |
| Size budgets | psyched 205 MB, app 530 MB, DMG 150 MB (the DMG is about 143 MB) | `deploy/size-budget.json` |

**Gaps this doc closes**

- **G1. No Gateway restart.** Squirrel swaps the bundle in place at the same path, so the next launch sees an unchanged plist. The supervisor then takes the `loaded && !changed && healthy` branch. The **old** psyched keeps running, now on top of replaced files, and any module it loads lazily comes from the new build.
- **G2. No snapshot before migrations.** The next boot migrates `~/.psyche` forward, and you can't undo that without a backup the user may not have made.
- **G3. No rollback.** ShipIt deletes the old bundle, and if the new version fails to start, nothing is left to go back to.
- **G4. No UX.** The updater checks once per launch, gives no "Restart to update", shows no release notes and has no channels. It doesn't respect running tasks or quiet hours, and nothing implements the `updates.check` setting that security §14 promises.
- **G5. Nothing has a stable identity.** There's no release certificate and no release key, which also keeps the updater off. A downloaded DMG shows "Apple could not verify" (expected for a self-signed app, section 3.1), and every ad-hoc build is a new app to macOS.
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

### 2.3 Signing and checks

Why a self-signed certificate is enough for the updater and for macOS permissions: both look at the **designated requirement** (DR) of the signature, not at who vouches for the certificate. A self-signed certificate gives the app the DR `identifier "com.psyche.desktop" and certificate leaf = H"<sha1>"`, which says "this bundle id, signed with exactly this certificate". Squirrel.Mac installs a new bundle only if it satisfies the running app's DR, and macOS keeps a privacy grant (TCC) for as long as the app still satisfies the requirement it was granted under. Keep the certificate and every release satisfies both. What a self-signed certificate does *not* give is Gatekeeper's trust (section 3.1).

Every release passes these checks before the updater installs it:
1. **Manifest:** Ed25519 over the exact bytes, by a key embedded in the app (exists). The private key lives offline and in the GitHub environment `release` with required reviewers (exists in the workflow; the key itself doesn't exist yet).
2. **Artifact:** SHA-256 and size, streamed before anything is kept (exists).
3. **Code signature:** Squirrel checks that the new bundle satisfies the running app's DR, `identifier "com.psyche.desktop" and certificate leaf = H"<sha1>"` (see 2.9). That check is why losing or replacing the certificate breaks updates.
4. **No notarization check.** There's no ticket to staple or validate. Gatekeeper's check applies only to a downloaded DMG on first open (section 3.1); the zip the app downloads itself is never assessed (section 3.1, "Updates the app downloads itself").

**When the updater runs.** Only when the running app's *own* signature satisfies the DR pinned in `deploy/macos/designated-requirements.txt` (forge copies the file into `Contents/Resources/`; `update-gate.ts` asks `bundle-integrity.ts`, which claims-then-verifies the app with `codesign --verify --deep --strict -R "=<requirement>"`, cached for a day so it is not a full verify on every launch) and `TRUSTED_RELEASE_KEYS` is non-empty. Ad-hoc builds, dev builds and copies re-signed by anyone else never update themselves: Squirrel would refuse them anyway. Until the owner runs `make-signing-cert.sh` and commits the hash, the file holds a placeholder and the updater stays off.

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
| Signing certificate | the self-signed "Psyche Release" certificate, made once (owner decision D1). There is no team ID: the identity **is** the certificate's SHA-1 hash |
| Designated requirement | `identifier "com.psyche.desktop" and certificate leaf = H"<sha1>"` for the app, `identifier "com.psyche.helper" and certificate leaf = H"<sha1>"` for the helper. Don't customise it per build, and never sign a release with another certificate |
| Helper location | `Contents/Resources/PsycheHelper.app` (TCC attributes the helper's requests to the outer app, #570) |
| Entitlements and usage strings | add keys, never remove ones a grant relies on |

The expected requirements live in `deploy/macos/designated-requirements.txt`. `deploy/macos/check-designated-requirements.sh` fails the release (it runs in `release.yml`) if the DR of the built app or helper differs, if any Gateway binary (the Node runtime, an addon, a library) is signed with another certificate, or if `Info.plist` sets `LSFileQuarantineEnabled`. The first build with the certificate is a one-time break for everyone on an ad-hoc build. That's only the owner today, and it's the `tccutil reset` that `install-local.sh` already prints.

**Library validation, and what it costs.** With no team ID the hardened runtime refuses to load *any* library Apple didn't sign, even one signed with the same certificate (measured on macOS 27: "mapping process and mapped file (non-platform) have different Team IDs"). Electron then can't load its own framework, and psyched's Node can't load `better-sqlite3` and the other addons. The fix is the narrowest one that works, and it is entitlement-only:
- `com.apple.security.cs.disable-library-validation` on the **app and Electron's helpers** (`apps/desktop/entitlements.self-signed.plist`; required, since Electron can't start without it) and on **psyched's Node runtime** (`entitlements.self-signed.psyched.plist`, which has just that key and `allow-jit`).
- **Not** on `PsycheHelper.app` (it links only system libraries and runs under full library validation) and not on the addons themselves. A Developer ID build keeps validation on: same team ID.
- **The cost, stated plainly.** With library validation off, malware running as the same user that can write inside a user-owned `/Applications/Psyche.app` (an app the user dragged there is owned by that user; no admin password is needed to change it) can swap a dylib inside the bundle. The swapped library then runs inside Psyche's process and **inherits Psyche's TCC grants (microphone, screen recording, Apple Events, Contacts, Calendar) and its keychain entries**. The hardened runtime still blocks `DYLD_*` injection, debugger attach and `task_for_pid`, but none of that stops this. It is a real, deliberate weakening, and it is not reachable by a remote attacker alone: it needs code already running as the user. A Developer ID build with library validation on does not have it.
- **What reduces it.** (1) *Bundle seal check.* The app verifies its own seal (`codesign --verify --deep --strict` against the pinned requirement, `bundle-integrity.ts`). A full verify costs seconds of CPU, so it is not run on every launch: the answer is cached for a day in the app's data folder, keyed on the app version and the seal file, and it runs before an update check. If it fails, the app shows a warning in the owner's language (all ten catalogues) at every launch and turns off the TCC-backed features until it is reinstalled: the Mac helper is not started (and a running one is stopped), permission requests are refused, and Ask about my screen and the dictation hotkeys are off. Be clear about what this is: a tripwire, not a wall. Malware that can write the bundle can also write the cache file or the app's code, and a swap made after the day's check goes unseen until the next one. It catches the common case, a bundle that was modified and left modified. (2) *Where the app lives.* A root-owned copy of the app, which same-user malware cannot write to, would remove the exposure. A drag install cannot make one without an administrator password, so this stays a note for managed Macs, not something the installer does.
- **Fuses cover only Electron.** `RunAsNode`, the `NODE_OPTIONS` fuse and the inspector fuse apply to the Electron app and its helpers, not to psyched, which runs the bundled official Node. psyched's launcher therefore closes the same doors by hand: it `unset`s `NODE_OPTIONS`, `NODE_PATH` and `NODE_REPL_EXTERNAL_MODULE`, and it preloads `psyched-harden.cjs`, which recomputes Node's global lookup paths without the user's home so `require()` never falls back to `~/.node_modules` or `~/.node_libraries` (Node has no flag for that; ESM imports never use them). That closes environment and per-user-folder injection into the Gateway. It does not stop code that can already write inside the bundle (see above).

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

**Goal:** download the DMG, drag Psyche to Applications, open it. Onboarding does the rest, with no Terminal and no scripts. Without notarization there is **one** extra step on the very first open (below), and none after it.

### 3.1 The self-signed identity, and what users see

- Sign the app, the nested helper, the Node runtime and every `.node` file with the **"Psyche Release" self-signed certificate**, hardened runtime, inside out, as forge and `bundle-resources.ts` already do. `deploy/macos/make-signing-cert.sh` makes the certificate once (RSA 3072 by default, or EC P-256; code-signing key usage; 20 years); the owner keeps the `.p12`, and CI imports it into a temporary keychain. A secure timestamp is requested in release builds (`PSYCHE_SIGN_TIMESTAMP=1`; Apple's timestamp server accepts a self-signed signature, verified 2026-11-05); local builds skip it.
- **No notarization, no stapling.** `release.yml` notarizes and staples only when an Apple API key *and* a Developer ID identity exist, and logs that it skipped them otherwise.
- **What users see.** A downloaded DMG (and the app dragged out of it) carries the quarantine flag, so the first open shows **"Apple could not verify "Psyche" is free of malware that may harm your Mac or compromise your privacy."** Before that, check the download against the `SHA256SUMS` on the release page (`shasum -a 256 Psyche-<version>-arm64.dmg`), because Open Anyway removes the one check macOS would otherwise make. The user clicks Done, opens **System Settings › Privacy & Security**, scrolls to Security, clicks **Open Anyway** next to "Psyche was blocked", and confirms once. After that it opens normally. The release notes carry these steps (`deploy/macos/open-anyway.md`), and so does the Homebrew cask's caveats. On macOS 15 the old right-click › Open shortcut no longer bypasses this, so the Settings route is the supported one.
- **Updates the app downloads itself.** The updater fetches the zip with Node's `fetch` and writes it with `createWriteStream`; Squirrel unpacks it. Neither sets `com.apple.quarantine`, which only apps that opt in (`LSFileQuarantineEnabled`) or browsers add, so an in-app update never shows the dialog again. We check this three ways: `check-designated-requirements.sh` fails the release if `Info.plist` ever sets `LSFileQuarantineEnabled`; the updater runs `xattr -p com.apple.quarantine` on the verified zip, strips the flag if it is somehow there (the file was just verified against the signed manifest) and logs it; and `updater.json` records `quarantine: absent|removed|unknown` so `psyche security audit` can show it. **Not yet verified on a real install:** that an update delivered through Squirrel's loopback feed launches with no prompt end to end. That needs an N-1 to N run on a Mac with the first signed release; it's the first item of the manual pre-stable checklist (section 4).
- The Gateway's own `psyched` is started by launchd from inside the bundle, so it is never quarantined separately.

### 3.2 `SMAppService` for the Gateway agent

Today the app writes a plist into `~/Library/LaunchAgents` and drives `launchctl`. On macOS 13+ (we require Sequoia, macOS 15), the supported way is `SMAppService.agent(plistName:)`:

- Ship `Contents/Library/LaunchAgents/com.psyche.gateway.plist` inside the signed bundle, with `BundleProgram` = `Contents/Resources/psyched/psyched` (bundle-relative), `KeepAlive`, `RunAtLoad` and `AssociatedBundleIdentifiers` = `com.psyche.desktop`.
- Register it from the main process. Electron supports this directly with `app.setLoginItemSettings({ openAtLogin: true, type: "agentService", serviceName: "com.psyche.gateway.plist" })`, and `getLoginItemSettings` returns its status (`enabled`, `requires-approval`, `not-registered`, `not-found`). No native addon is needed.
- **What we gain:**
  - Updates need no plist rewrite, because the path is relative to the bundle and the bundle is swapped in place.
  - Login Items shows "Psyche" with our icon instead of an anonymous "node". (A self-signed app is listed there as from an unidentified developer; the item is still "Psyche" with our icon.)
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

- **Homebrew cask** (exists as a template): set up `devmello/homebrew-psyche` with a fine-grained token, and add `auto_updates true` so that `brew upgrade` doesn't fight the in-app updater. Extend `zap` with the helper's paths (`~/Library/Preferences/com.psyche.helper.plist`, `~/Library/Caches/com.psyche.helper`, `~/Library/Application Support/com.psyche.helper`, the saved states) so it matches `install-local.sh`. **Our own tap only:** the main `homebrew/cask` repository requires a notarized app, so `brew install --cask psyche` is not available and the command stays `brew install --cask devmello/psyche/psyche`. Homebrew quarantines the app like a browser does, so the "Open Anyway" step applies; the cask's caveats say so.
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
| Build psyched + helper + app (unsigned) | `macos-26` (arm64), `macos-15-intel` (x64) | Exists, minus signing. These jobs run the whole dependency tree's build code, so they get **no environment and no signing secrets**: the app is packaged ad-hoc and uploaded as an `unsigned-*` artifact, as are the CLI binaries. Stamp `CFBundleVersion` = `<run number>` (monotonic) next to the semver `CFBundleShortVersionString` |
| **Sign** (one job, one approval per tag) | `macos-26`, environment `release` | A single small `sign` job downloads the unsigned apps and CLI binaries, creates the temporary keychain from the three secrets, and signs inside out with `deploy/macos/sign-bundle.sh` (the same script `build-local.sh` runs, so local and CI signing cannot drift): Psyche's Node and addons, the rest of the bundle, the helper with its own entitlements, then the app with the pinned requirement. While the keychain is unlocked it runs only `codesign`, `ditto`, `hdiutil`, `security`, the DMG script and our own check scripts, no package manager and no dependency code. It then makes the DMGs from the signed apps and locks and deletes the keychain in an `always()` step. No notarization or stapling (Appendix A) |
| Zip (updater) + DMG | the `sign` job | The DMG is signed with the same identity inside the unlocked window; the zip is made from the signed app after the keychain is gone, with `ditto`, so it carries no quarantine flag |
| Checks | the `sign` job | On the signed output: `codesign --verify --deep --strict`; the DR of app and helper matches `designated-requirements.txt` and every Gateway binary has the same certificate (`check-designated-requirements.sh`); no `LSFileQuarantineEnabled`; the hardened runtime on for the app, Electron's helpers, the Mac helper and psyched's Node; no `allow-dyld-environment-variables` or `get-task-allow`; library validation kept on the Mac helper; fuses (`deploy/scripts/read-fuses.mjs`, our own reader: RunAsNode, the NODE_OPTIONS and inspector fuses off, asar integrity and only-load-from-asar on); size: zip and DMG ≤ `dmgMB`, app ≤ `appMB`, psyched ≤ `psychedMB`. The `release` job (manifest signing, GitHub Release) depends on `sign` and uses only its outputs; it deletes every `unsigned-*` artifact and fails a publishing run the `sign` job did not sign |
| **Smoke test** | fresh `macos-26` job | New. Download the DMG artifact, mount it, copy the app to `/Applications`, run `Psyche.app/Contents/Resources/psyched/psyched --bundle-check`, then start psyched with a temp `PSYCHE_HOME` and wait for `/healthz`. Then the **upgrade path**: run `deploy/scripts/upgrade-roundtrip.mjs` against the previous release's psyched (downloaded from its release) and the new one, which proves the migrations and the pre-update snapshot on real data. A full GUI auto-update run (N-1 app updating itself to N) needs a test feed on the pinned host, so do it as a manual pre-stable checklist item, not in CI. That run is also where "an in-app update shows no Gatekeeper prompt" is confirmed on a real install |
| Manifest | ubuntu, env `release` | Exists. Add `channel`, `notes` and `build`. Publish to the release **and** overwrite `update-feed/<channel>.json` + `.sig` |
| GitHub Release | ubuntu | Exists. The notes end with the "Opening Psyche the first time" section (`deploy/macos/open-anyway.md`) |
| Homebrew | ubuntu | Exists (skips without a token). Add `auto_updates true` |

**Version scheme:** semver, managed by changesets, with `0.x` until 1.0 (a minor may break). Prereleases are `-alpha.N`, `-beta.N` and `-rc.N`. One version covers the app, psyched, the CLI and the images. The build number is the workflow run number. Security releases raise `deploy/update-policy.json` `minimumVersion` in the same PR as the fix.

**Secrets** (all already named in `release.yml`; the macOS ones belong in the `release` environment, not the repository): `MACOS_CERTIFICATE_P12_BASE64` (the self-signed `psyche-release.p12`), `MACOS_CERTIFICATE_PASSWORD`, `MACOS_SIGNING_IDENTITY` (its SHA-1), `RELEASE_SIGNING_KEY` (environment `release`, required reviewer = owner) and `HOMEBREW_TAP_TOKEN`. Optional, only for the paid path in Appendix A: `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

---

## 5. Windows and Linux, later

Keep the same shape: one signed bundle per platform, the same Ed25519 manifest with `platform` widened, the Gateway as a supervised background process, and the snapshot before migrating in the Gateway (it's already cross-platform). See [cross-platform-2026.md](cross-platform-2026.md).

- **Windows.** Use electron-builder NSIS plus `electron-updater`, or MSIX. Prefer NSIS per-user (no admin rights, deltas via blockmap), still behind our manifest. Sign with Azure Trusted Signing, which is cheap and avoids an EV token. The Gateway runs as a per-user Scheduled Task at logon, or a `Run` key, not a service, to stay per-user like the LaunchAgent. The helper is C# and ships inside the install folder under the same rules: a stable publisher and stable paths, so Windows privacy prompts keep their answers.
- **Linux.** AppImage with an embedded zsync update (deltas for free), plus a `.deb`/`.rpm` from a signed apt/dnf repo for people who prefer that. The Gateway uses the existing `systemd --user` unit (`deploy/systemd`). No helper equivalent yet.

---

## 6. Plan

Each step is one PR, in order. Steps 1–3 need no keys. Steps 4 onwards need the owner's certificate and release key (section 7). Nothing needs an Apple account.

| # | PR | What | Needs |
| --- | --- | --- | --- |
| 1 | **Gateway build in the handshake** | `server` in `ConnectChallenge`. The supervisor restarts the agent on a build mismatch. `PSYCHE_BUILD` in the plist env. Fixes G1 for local installs too | — |
| 2 | **Pre-update snapshot** | The snapshot before pending migrations, restore on a failed migration, retention, the tolerant check for unknown `config.json` keys. Extend `upgrade-roundtrip.mjs` | — |
| 3 | **`gateway.prepareUpdate`** | Drain, checkpoint, then `ready`. Add "is anything busy?" for the UI (running tasks, pending approvals) | — |
| 4 | **Owner: certificate and keys** | Run `deploy/macos/make-signing-cert.sh` and back up the `.p12`; commit its SHA-1 in `designated-requirements.txt`; the release key (`update-manifest.mjs keygen`); the GitHub secrets and the `release` reviewers | owner |
| 5 | **Self-signed release + checks** *(code landed 2026-11-05)* | The public release key in `release-keys.ts`. Sign with the self-signed certificate; add the `codesign --verify`/DR/fuse/size checks and the Open Anyway notes to `release.yml`; the updater runs only on a build that satisfies the pinned DR. Cut `0.4.0-beta.1` signed. The owner reinstalls once by hand and approves it with Open Anyway (the last manual install) | 4 |
| 6 | **Update flow** | Periodic, wake-time and jittered checks. `updates.check`. Background download. The apply sequence (clone previous → prepareUpdate → bootout → quit helper → `quitAndInstall`). The busy gates | 1, 3, 5 |
| 7 | **Update UI** | Settings › About › Updates, the tray row, the quiet-hours notification, the required-update banner, the automatic install at idle | 6 |
| 8 | **Rollback** | Launch probation, the "Go back" screen on the splash, `skip-builds.json` | 2, 6 |
| 9 | **Channels + notes** | `update-feed` rolling release, `channel`/`notes`/`build` in the manifest, the channel picker, "What's new" | 6 |
| 10 | **SMAppService** | The bundled agent plist, `setLoginItemSettings({type: "agentService"})`, the `requires-approval` UI, migration from the old plist. Script mode stays for a dev `PSYCHE_HOME`. Test it on a self-signed build first: background items from an app without a team ID are listed as from an unidentified developer and may need the same one-time approval | 5 (needs a stable signature to test meaningfully) |
| 11 | **First-run install hooks** | Move to Applications. Hand off to onboarding (coordinate with the onboarding session; no permission prompts outside it) | 10 |
| 12 | **Uninstall + Homebrew** | The uninstall sheet. The cask gets `auto_updates true` and the full `zap`. The tap repo goes live (our own tap; main `homebrew/cask` needs notarization). `install.md` rewritten around the DMG and Open Anyway | 5 |
| 13 | **CI smoke test** | The fresh-runner DMG install, `--bundle-check`, the N-1 → N roundtrip | 5 |

`install-local.sh` stays as the developer path. Make `--keep-data` the default and the wipe an explicit `--reset`, because people will run it against a real install once updates exist.

### Risks

| Risk | Mitigation |
| --- | --- |
| **Certificate loss or rotation** (the new "team ID change"): the `.p12` is lost, expires (20 years), or a release is signed with another certificate. Squirrel refuses any bundle whose DR differs, so auto-update stops for every installed copy, and every TCC grant resets | Keep the `.p12` and its password in a password manager plus one offline copy, and in GitHub only as the three secrets of the `release` environment. `check-designated-requirements.sh` blocks a release signed with another certificate. If it must change on purpose: ship one last release signed with the **old** certificate that tells users to reinstall, then switch, update `designated-requirements.txt`, and announce one manual reinstall and a `tccutil reset` |
| **Certificate leak** (the `.p12` and its password both got out) | **There is no revocation.** A self-signed certificate has no CA, CRL or OCSP, and macOS never asks anyone whether it is still good. Raising `minimumVersion` does nothing against it: that only forces an update, and the attacker's update signed with the leaked certificate satisfies the same DR. Every installed copy keeps trusting that certificate, and it keeps its TCC grants for anything signed with it, until each user runs `tccutil reset All com.psyche.desktop` and reinstalls from a build signed with a **new** certificate. What the owner can do: stop publishing with it, make a new certificate (`make-signing-cert.sh`), commit the new hash, announce the leak and a manual reinstall to every user (release notes, site, the tap), and rotate `RELEASE_SIGNING_KEY` too if it could have been exposed with it (an attacker also needs the Ed25519 key to push a manifest, which is the second lock). Before it happens: keep the `.p12` out of every repository (`*.p12` is gitignored; `make-signing-cert.sh` refuses to write inside a git work tree) and keep its password only in the password manager and the `release` environment |
| The release key is lost or leaks | Offline copy in a password manager, plus the `release` environment with required reviewers. Rotation is already specified (security §11). Raise `minimumVersion` on a leak |
| A migration bug corrupts data | A pre-update snapshot of every database, restore on failure, the CI roundtrip on real N-1 data, "Go back" |
| Squirrel fails for non-admin accounts (can't write to `/Applications`) | Detect it (`access` W_OK on the bundle's parent). Show "Download the update" linking the DMG, the same check-and-notify flow without the install |
| An update interrupts work | The busy gates. `prepareUpdate` checkpoints. A restart is never forced while a task runs, even for required updates |
| Notarization flakes or stalls in CI | Only relevant to the paid path (Appendix A): `notarytool --wait --timeout 30m`, one retry. Notarization runs before the zip, so a failure publishes nothing |
| An in-app update is quarantined and shows "Apple could not verify" on every update | Nothing we write sets the flag, `Info.plist` must never set `LSFileQuarantineEnabled` (checked in the release), and the updater strips the flag if it ever finds one. Verify on the first signed release (section 3.1) |
| Library validation is off for the app and psyched | Section 2.9 states the cost plainly (same-user malware that can write inside the bundle can swap a dylib and inherit Psyche's TCC grants and keychain entries) and the mitigations: it is confined to the files that need it, the hardened runtime stays on, the app verifies its own seal once a day and turns the TCC-backed features off when it fails, and psyched's launcher clears `NODE_OPTIONS`/`NODE_PATH` and the per-user module folders |
| The signing secrets could reach third-party build code | They cannot: the secrets exist only in the `sign` job (`environment: release`: tags only, required reviewers, one approval per tag). The jobs that build (`dmg`, `cli`) have no environment and no secrets, and the `sign` job runs no package manager, build tool or dependency code while its keychain is unlocked (its checks use `node` only on our own scripts, with no imports beyond `node:*`). The keychain is locked and deleted right after the last signing step, in an `always()` step. What is left: a bug in `sign-bundle.sh`, `codesign`, the DMG script or our check scripts, all of which are in this repository and reviewed like any code |
| The Intel runner keeps breaking the helper (Swift 6) | Owner decision D4 |
| The SMAppService move breaks a custom `PSYCHE_HOME` | Keep script mode for dev, and document that the packaged app always uses `~/.psyche` |
| A clone of the previous bundle on a non-APFS volume costs a full 443 MiB | Only `/Applications` on the system volume is supported. Skip the clone (and say "Go back unavailable") elsewhere |

---

## 7. What the owner needs to do or decide

**One-time actions** (nothing needs an Apple account)

1. **Make the release certificate**, once, on your Mac: `deploy/macos/make-signing-cert.sh --out ~/psyche-signing`. It asks for a password (not shown), writes `psyche-release.p12` and prints the SHA-1, SHA-256 and the designated requirement. It imports nothing into your keychain. Back up the `.p12` and the password; this certificate is the app's identity.
2. **Pin it**: put the SHA-1 in `deploy/macos/designated-requirements.txt` (both lines) and commit. Then add `MACOS_CERTIFICATE_P12_BASE64` (`base64 -i psyche-release.p12`), `MACOS_CERTIFICATE_PASSWORD` and `MACOS_SIGNING_IDENTITY` (the SHA-1) as **secrets of the `release` environment** (Settings, Environments, `release`: deployment tags `v*` only, you as required reviewer), **not** as repository secrets. Repository secrets are readable by every workflow run; environment secrets are released only to a reviewed tag run. Only the `sign` job reads them, and a publishing run fails there rather than ship an ad-hoc build. The release then waits for one approval per tag (the `sign` job's), not one per build job.
3. **Generate the release key** offline with `node deploy/scripts/update-manifest.mjs keygen`. Keep the private half in your password manager and in `RELEASE_SIGNING_KEY` (the same `release` environment). The public half goes into `release-keys.ts` in the next PR.
4. **Create the tap repo** `devmello/homebrew-psyche` and a fine-grained `HOMEBREW_TAP_TOKEN` (contents: write on that repo only).
5. **Reinstall by hand once** when the first signed build ships, approve it with Open Anyway, then run `tccutil reset All com.psyche.desktop && tccutil reset All com.psyche.helper` and grant permissions again. After that, updates keep the grants.

**Decisions, each with a recommendation**

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Signing identity | **Self-signed "Psyche Release"** (decided 2026-11-05: no Developer ID, no notarization). Pick the certificate once: replacing it later is the "team ID change" risk in section 6. Algorithm: RSA 3072 (default) or EC P-256; both sign and verify on macOS 27 |
| D2 | Updater | **Squirrel.Mac behind our manifest** (section 2.1) |
| D3 | Install updates automatically by default | **On**: only when idle, never during a task, preferring quiet hours |
| D4 | Intel Macs | **Ship arm64 only from 0.4** and drop the x64 DMG job, unless you know of Intel users. It halves the release time, and the Intel toolchain keeps breaking the helper |
| D5 | Channels | **stable + beta**. Alpha stays manual |
| D6 | Deltas | **Not now**. Measure first (section 2.4) |
| D7 | SMAppService, and a packaged `PSYCHE_HOME` that is always `~/.psyche` | **Yes** |
| D8 | Rollback | **One click** after a failed launch, not automatic |
| D9 | `curl \| sh` installer | **No**. The DMG and the Homebrew cask are enough |
| D10 | Submit to the main `homebrew/cask` | **No**: it requires notarization. Our own tap only, unless Appendix A is ever taken |

---

## Appendix A. The paid Developer ID path (later)

Optional, not planned. If the owner ever joins the Apple Developer Program ($99 a year), the code already supports it: set `MACOS_SIGNING_IDENTITY` to the "Developer ID Application: Name (TEAMID)" name and add the App Store Connect API key secrets (`APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). Then the `sign` job would sign with the Developer ID (electron-forge does it for a local `build-local.sh` build, where `PSYCHE_SIGN_IDENTITY` is a Developer ID) and gain a notarize step (`notarytool`), `stapler staple` before zipping, `spctl -a -vvv -t exec` and `stapler validate`; that step is **not in `release.yml` today**, since `sign-bundle.sh` refuses a Developer ID. The first open would become a single "downloaded from the internet, open?" prompt with no Open Anyway.

What changes:
- **Identity.** The DR becomes `identifier "com.psyche.desktop" and anchor apple generic and certificate leaf[subject.OU] = "<TEAMID>"`, and `designated-requirements.txt` changes with it (the updater reads its pinned line from that file). **This is a certificate change** (section 6): every installed self-signed copy has a different DR, so Squirrel refuses the update. Bridge it with one release signed by the old certificate that tells users to reinstall, and expect one `tccutil reset`.
- **Library validation** can go back on everywhere: the helper, the addons and psyched's Node share the team ID, so `disable-library-validation` and the two `entitlements.self-signed*.plist` files are no longer used (a Developer ID build never reads them).
- **Homebrew** can be submitted to the main `homebrew/cask`.
- **Choosing the account type:** an individual account is enough; an organization needs a D-U-N-S number and takes weeks. The team ID is permanent for the app's life.
- **What goes away:** the "Apple could not verify" dialog and the Open Anyway step. Nothing else in the update design (manifest, Squirrel, snapshots, rollback) depends on which path is taken.
