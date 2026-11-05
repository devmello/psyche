# Signing the desktop app

Releases are signed with **Psyche's own self-signed certificate** (no Apple Developer ID, no
notarization; docs/design/updates-and-install-2026.md §2.3, §3.1). A paid Developer ID still works
as an optional later path (design Appendix A). Builds on a Mac are **ad-hoc signed by default** (CI
included); builds on other hosts are unsigned. A real identity switches on only when the
environment variables below are set
(`src/packaging/signing-config.ts`, read by `forge.config.ts`). Never commit real values. Keep API
keys and passwords in your keychain or a secrets manager and export them only for the shell
that runs the build.

## Why sign at all

- **TCC.** macOS ties Accessibility, Screen Recording, Microphone and Automation grants to the
  code signature, bundle id and path. Ad-hoc signatures create a new identity on every build, so
  an unsigned dev build loses its grants each time you rebuild (security §12). Reset with
  `tccutil reset Accessibility com.psyche.desktop` (or `ScreenCapture`, `Microphone`,
  `AppleEvents`).
- **`safeStorage`, notifications and `autoUpdater`** all need a stable signature (security §11).
- **Gatekeeper** blocks downloaded apps unless they are signed and notarized.

## The self-signed release certificate

Make it once, on your own Mac. Nothing is imported into your keychain unless you ask:

```sh
deploy/macos/make-signing-cert.sh --out ~/psyche-signing
```

It asks for a password (typed, not shown), writes `psyche-release.p12` (refusing to overwrite one) and prints the SHA-1 and SHA-256 and the designated requirement the certificate implies:
`identifier "com.psyche.desktop" and certificate leaf = H"<sha1>"`. Put the SHA-1 in
`deploy/macos/designated-requirements.txt` (the release check and the updater read it) and set the
secrets `MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD` and
`MACOS_SIGNING_IDENTITY` (the SHA-1) **in the `release` environment** (Settings, Environments,
`release`: deployment tags `v*` only, you as required reviewer), not as repository secrets. A
publishing run fails without them; it never ships an ad-hoc build. Use a random password of 20 or
more characters (`openssl rand -base64 24`) and keep it in your password manager. **Back up the `.p12` and its password.** The certificate is the
app's identity: losing or replacing it stops auto-update for every installed copy and resets every
macOS permission (design §6, "Certificate loss or rotation").

To sign a local build with it, import it into a keychain **you** name (never trust it; trust is not
needed): `make-signing-cert.sh --import-to <keychain>`, or point the build at a keychain file with
`PSYCHE_SIGN_KEYCHAIN`. `deploy/macos/build-local.sh` then picks up a "Psyche Release" identity
on its own.

## Who signs what

- **Release (CI):** the `dmg` and `cli` jobs build unsigned (ad-hoc), with no environment and no signing
  secrets. One `sign` job (`environment: release`) signs the app inside out with
  `deploy/macos/sign-bundle.sh`, checks it, makes the DMGs and signs the CLI binaries, running only
  Apple's tools and our own scripts while its keychain is unlocked.
- **Local self-signed build:** `deploy/macos/build-local.sh` packages ad-hoc and then runs the same
  `sign-bundle.sh`, so a local build is signed exactly like a release.
- **Developer ID (optional, later):** `electron-forge package` signs (and notarizes) it, using
  `PSYCHE_SIGN_IDENTITY` as described below. `signing-config.ts` also still signs a self-signed identity
  if you set it for `pnpm --filter @psyche/desktop package` directly.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PSYCHE_SIGN_IDENTITY` | What to sign with: the SHA-1 (or name) of the self-signed "Psyche Release" certificate, or `Developer ID Application: Jane Doe (TEAMID1234)`. Turns on `osxSign` with the hardened runtime. A signing failure fails the build. |
| `PSYCHE_SIGN_KEYCHAIN` | The keychain file that holds the identity (CI uses a temporary one). Without it the search list is used. |
| `PSYCHE_SIGN_TIMESTAMP` | `1` asks Apple's timestamp server for a secure timestamp on a self-signed signature (verified to work without a Developer ID; needs the network). Default: none. A Developer ID is always timestamped. |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Optional, Developer ID only. Notarization with an App Store Connect API key (preferred). `APPLE_API_KEY` is the path to the `.p8` file. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Optional, Developer ID only. Notarization with an Apple ID and an app-specific password, used only when the API key set is incomplete. |

Notarization runs only for a **Developer ID** identity with one complete credential set. A self-signed
build skips it, and the forge log says so (`[forge] signing: self-signed identity, ... skipping
notarization`). Partial credential sets are ignored.

## Sign and notarize locally

```sh
security find-identity -v -p codesigning   # copy the "Developer ID Application" name

export PSYCHE_SIGN_IDENTITY="Developer ID Application: Jane Doe (TEAMID1234)"
export APPLE_API_KEY="$HOME/.appstoreconnect/AuthKey_ABC123.p8"
export APPLE_API_KEY_ID="ABC123"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"

pnpm --filter @psyche/desktop make
```

The app ends up in `apps/desktop/out/Psyche-darwin-<arch>/Psyche.app` and the ZIP in
`apps/desktop/out/make/`. DMG and the signed release manifest come with the release pipeline
(S22/C2).

## Check the result

```sh
APP=apps/desktop/out/Psyche-darwin-arm64/Psyche.app

codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --entitlements - "$APP"          # allow-jit and audio-input only
codesign -dvv "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier|flags'   # flags include "runtime"
codesign -d -r- "$APP"                       # designated => identifier "com.psyche.desktop" and certificate leaf = H"<sha1>"
# Developer ID only (a self-signed app is "rejected" by spctl until the user clicks Open Anyway):
spctl -a -vvv -t exec "$APP"                 # "accepted", "source=Notarized Developer ID"
xcrun stapler validate "$APP"

# Self-signed release: the designated requirement and the Gateway binaries (what release.yml runs)
deploy/macos/check-designated-requirements.sh "$APP"

# Developer ID only. Notarization history and the log for a submission:
xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
xcrun notarytool log <submission-id> --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
```

## What gets signed, in order

The package step copies three pieces into `Psyche.app/Contents/Resources/` before signing
(`src/packaging/bundle-resources.ts`): `psyched/` (S22's Gateway bundle, `node deploy/scripts/build-psyched.mjs`),
`launchd/com.psyche.gateway.plist` (its LaunchAgent template) and `PsycheHelper.app` (S14's
helper, `deploy/macos/build-helper.sh`, run with the same `PSYCHE_SIGN_IDENTITY`). A missing piece fails the package step with the
build command to run; `PSYCHE_PACKAGE_ALLOW_PARTIAL=1` packages without it (dev and CI smoke
builds). `PSYCHE_PSYCHED_DIR` and `PSYCHE_HELPER_APP` point at other builds.

1. `PsycheHelper.app` arrives signed by its own build with its own entitlements
   (docs/archive/status/s14.md "Packaging"). The package step only verifies it (`codesign --verify
   --strict`) and fails when it is ad-hoc while the app has a Developer ID.
2. osx-sign signs everything else inside out with the same identity: Electron's helpers and
   frameworks, node-pty, and only the Mach-O files under `psyched/` (`runtime/node`, `.node`,
   `.dylib`); the rest of `psyched/` is sealed as resources. The helper is skipped there.
3. The outer `Psyche.app` last.

Ad-hoc builds use no hardened runtime and no timestamp server, so psyched's native addons load
without library validation. TCC grants on an ad-hoc build key on the code hash and are lost on
every rebuild.

## Entitlements

`entitlements.plist` (Developer ID builds) is applied to the app, every Electron helper and the
Mach-O files in `psyched/` (`runtime/node` needs allow-jit under the hardened runtime).
`PsycheHelper.app` keeps its own (`apps/mac-helper/Support/PsycheHelper.entitlements`). The app's are:

- `com.apple.security.cs.allow-jit` for V8 under the hardened runtime.
- `com.apple.security.device.audio-input` for dictation, paired with `NSMicrophoneUsageDescription`.

There is no `allow-unsigned-executable-memory` (Electron 44 does not need it) and, for a Developer
ID build, no `disable-library-validation`. node-pty's `pty.node` and `spawn-helper` are unpacked from
the asar and signed with the app.

### Self-signed builds: library validation

A self-signed certificate has no team ID, and with no team ID the hardened runtime refuses to load any
library Apple did not sign, even one signed with the same certificate (measured on macOS 27 with a
certificate from `make-signing-cert.sh`: "mapping process and mapped file (non-platform) have
different Team IDs"). Electron cannot load its own framework, and psyched's Node cannot load its
native addons. So a self-signed build uses two other files, and only these two carry
`com.apple.security.cs.disable-library-validation`:

| File | Applied to | Keys |
| --- | --- | --- |
| `entitlements.self-signed.plist` | the app and Electron's helpers | everything in `entitlements.plist` plus `disable-library-validation` (required: Electron will not start without it) |
| `entitlements.self-signed.psyched.plist` | the files under `Contents/Resources/psyched/` (what matters is `runtime/node`) | `allow-jit` and `disable-library-validation` only |

`PsycheHelper.app` links only system libraries and keeps full library validation.

**What it costs, plainly.** With library validation off, malware running as the same user that can
write inside a user-owned `/Applications/Psyche.app` can swap a dylib in the bundle, and the swapped
library then runs inside Psyche's process and inherits its TCC grants (microphone, screen, Apple
Events, Contacts, Calendar) and keychain entries. The hardened runtime still blocks `DYLD_*`
injection and debugger attach, but not that. Mitigations (design §2.9) are partial: the app verifies
its own seal once a day (`bundle-integrity.ts`, cached) and, if it fails, warns in the owner's language
and turns the TCC-backed features of the app off until a reinstall; the Gateway keeps running. That is
a tripwire for an attacker who does not know about it, not containment: a swapped library that loads at
launch runs before the check and can hide it. The updater does not depend on that verdict (it checks
the claimed requirement and a shallow `codesign --verify --strict`), so a stray file never blocks
updates. The Electron fuses cover only Electron, so the psyched and `psyche` launchers clear
`NODE_OPTIONS`, `NODE_PATH` and `NODE_REPL_EXTERNAL_MODULE` and preload `psyched-harden.cjs` (no
`~/.node_modules` lookup); that is defence in depth, not a boundary (the LaunchAgent plist is
user-writable and the signed `runtime/node` can be run directly). Check which files carry the
entitlement with `codesign -d --entitlements - <file>`; `release.yml` also fails the release if the
hardened runtime is off anywhere, if any file has `allow-dyld-environment-variables` or
`get-task-allow`, or if `PsycheHelper.app` has `disable-library-validation`.

**If the certificate leaks:** there is no revocation, and raising `minimumVersion` does not help. See
design §6, "Certificate leak".

## Fuses

These are flipped at package time: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off,
`EnableNodeCliInspectArguments` off, embedded ASAR integrity on, `OnlyLoadAppFromAsar` on,
`EnableCookieEncryption` on, `LoadBrowserProcessSpecificV8Snapshot` off, and
`GrantFileProtocolExtraPrivileges` off, because the renderer loads from `app://`. Inspect a
build with `npx @electron/fuses read --app "$APP"`.

## Updates: the signed manifest

Code signing makes Squirrel.Mac accept an update; it does not say which update is current or that the zip is the one the release meant. The updater therefore applies an update only after verifying `update-manifest.json` with an Ed25519 release key embedded in the app (`src/main/release-keys.ts`), the downloaded zip's SHA-256, and that it is newer and comes from the pinned release host (security §11, "Update manifest" and "Release key"). The release workflow produces the zip and signs the manifest with `RELEASE_SIGNING_KEY` from the `release` environment; without that secret it publishes no manifest and installed apps do not update. The updater also runs only when the running app's own signature satisfies the designated requirement pinned in `deploy/macos/designated-requirements.txt` (`src/main/update-gate.ts`); an ad-hoc, development or re-signed copy returns `disabled`. Until the first key is embedded, `startUpdater` returns `no_keys` and does nothing.

## Without any identity: ad-hoc signed DMG

`deploy/macos/make-dmg.sh` builds the installer DMG from a packaged `Psyche.app`. Without
`PSYCHE_SIGN_IDENTITY` the package step already signs the app ad-hoc, inside out, and the script
only checks it with `codesign --verify --deep --strict`. If that fails and the app bundles
`PsycheHelper.app`, the script stops: `--deep` would re-sign the helper with the app's
entitlements and drop its own, so re-run the package step on macOS instead. Only an app without
the helper (a partial dev package) is signed ad-hoc in the DMG copy:

```sh
codesign --force --deep --sign - --entitlements apps/desktop/entitlements.plist Psyche.app
```

That fallback has no hardened runtime, so library validation does not reject the bundled
Gateway's Node runtime and native addons (`Contents/Resources/psyched/`). The DMG also
holds an `Applications` link and a background with drag-to-install instructions, and a
`Psyche-<version>-<arch>.dmg.sha256` file is written next to it. With `PSYCHE_SIGN_IDENTITY` the app
is signed by `electron-forge package` as above and the DMG is signed with the same identity (a
Developer ID, with credentials, is also notarized and stapled; a self-signed one is not).

Gatekeeper does not trust an ad-hoc or self-signed app downloaded from the internet. To open it the first time:

1. Drag Psyche to Applications and open it. macOS refuses with "Psyche can't be opened" (or
   "cannot verify that it is free of malware"). Click **Done**.
2. Open **System Settings › Privacy & Security**, scroll to Security, and click **Open Anyway**
   next to the Psyche message. Confirm with your password.

On macOS 14 and earlier, right-clicking (Control-clicking) the app in Finder and choosing **Open**
does the same. From macOS 15 on, right-click Open no longer skips the check, so use the
System Settings button. If you verified the checksum and prefer the terminal, run
`xattr -dr com.apple.quarantine /Applications/Psyche.app`.

Check the checksum before you trust the download:

```sh
shasum -a 256 -c Psyche-<version>-<arch>.dmg.sha256
```

TCC grants (Accessibility, Screen Recording, Microphone) are tied to the signature. An ad-hoc
build gets a new identity with every release, so after an update macOS may ask for them again.

## Windows: Authenticode

Windows builds (`pnpm app:build` on Windows, `deploy/windows/build-local.ps1`) are **unsigned by
default** and still install and run; SmartScreen warns about an unsigned installer ("Windows
protected your PC" › More info › Run anyway). Authenticode signing switches on only when one of
these sets is complete (`windowsSigning` in `src/packaging/signing-config.ts`):

| Variable | Purpose |
| --- | --- |
| `WINDOWS_CERTIFICATE_FILE`, `WINDOWS_CERTIFICATE_PASSWORD` | A code-signing certificate as a `.pfx` file and its password. |
| `WINDOWS_TIMESTAMP_SERVER` | Optional, with the PFX: the RFC 3161 timestamp server (default `http://timestamp.digicert.com`). |
| `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`, `AZURE_TRUSTED_SIGNING_DLIB` | Azure Trusted Signing: the region endpoint (e.g. `https://eus.codesigning.azure.net`), the code signing account, the certificate profile and the path to `Azure.CodeSigning.Dlib.dll`. Used when the PFX pair is not set. |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | The service principal the dlib signs as (read by the dlib, not by Psyche). |
| `WINDOWS_SIGNTOOL_PATH` | Optional: a Windows SDK `signtool.exe`. Trusted Signing needs one newer than the copy `@electron/windows-sign` vendors. |

Everything is signed with SHA-256 only. The packager signs every `.exe`, `.dll` and `.node` under the
app folder before the installer is made, so `Psyche.exe`, `resources\psyched\runtime\node.exe`, the
native addons and `resources\win-helper\psyche-helper.exe` all carry the signature; the Squirrel
maker then signs `Setup.exe` and the `Update.exe` it embeds. In CI (`desktop.yml`, job `windows`, and
`release.yml`, job `windows`) the PFX comes from the `WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD` secrets, or
Trusted Signing from the `AZURE_*` secrets; without them the job builds unsigned. Because the Squirrel
maker signs inside `make`, Windows cannot follow the macOS "build unsigned, sign later" split: the
release's `windows` job builds and signs, and runs in the `release` environment, so put these secrets
**in that environment** next to the macOS ones (a dry run uses `release-dry-run` and builds unsigned).

Check a build:

```powershell
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Psyche\app-<version>\Psyche.exe" | Format-List Status, SignerCertificate
```

The updater runs only on a Squirrel install whose `Psyche.exe` has a valid signature (`Status` is
`Valid`), like the Developer ID requirement on macOS.

### Install layout and identity

Squirrel.Windows installs per user, without administrator rights:

| Path | What |
| --- | --- |
| `%LOCALAPPDATA%\Psyche\Update.exe` | Squirrel (install, update, uninstall) |
| `%LOCALAPPDATA%\Psyche\Psyche.exe` | Stub that starts the newest version; the shortcuts point here |
| `%LOCALAPPDATA%\Psyche\app-<version>\Psyche.exe` | The app (`<version>` is the NuGet form, e.g. `0.3.0-alpha0`) |
| `…\app-<version>\resources\app.asar` | The desktop and web UI |
| `…\app-<version>\resources\psyched\` | The Gateway: `psyched.cmd`, `psyche.cmd`, `runtime\node.exe`, `app\`, `service-host.mjs`, `psyche-gateway.task.xml.template` |
| `…\app-<version>\resources\win-helper\psyche-helper.exe` | Psyche Helper |
| `…\app-<version>\resources\tray.ico` | The notification-area icon |
| `%LOCALAPPDATA%\Psyche\packages\` | The installed nupkg, for delta updates |
| `%APPDATA%\Psyche\` | The desktop's settings, web storage and caches |
| `%USERPROFILE%\.psyche\` | `$PSYCHE_HOME`, as on macOS |

The identity values are shared with the helper's build through `apps/win-helper/aumid.json`;
changing one orphans existing shortcuts, toast settings and notification history:

| | Value |
| --- | --- |
| App AppUserModelID | `com.psyche.desktop` (the app must call `app.setAppUserModelId` with it) |
| Helper AppUserModelID | `com.psyche.helper` |
| Helper toast activator CLSID | `{B1DFC43D-98FC-44C2-9C1B-F3C21D0871C6}` |

`src/main/squirrel-events.ts` handles Squirrel's events before anything else in `main.ts` starts:

- `--squirrel-install`: the Programs and Features icon (`resources\icon.ico` copied to `%LOCALAPPDATA%\Psyche\app.ico`, named as `DisplayIcon` of `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Psyche`; Squirrel downloads the nupkg's `iconUrl` into that file only while it is missing, so an install fetches nothing; the `iconUrl` in `forge.config.ts` is a local `file://` URL for the same reason); `Psyche.lnk` in the Start menu (`%APPDATA%\Microsoft\Windows\Start Menu\Programs`) and on the desktop, both on the stub with the app's AUMID; `Psyche Helper.lnk` in the Start menu on `psyche-helper.exe` with the helper's AUMID and toast activator CLSID; and the helper's toast identity as the helper itself registers it on every start (`apps/win-helper/src/notify/toast.rs`), so the first toast works before the helper ever ran: `HKCU\Software\Classes\CLSID\{…}` (`Psyche Helper toast activator`) with `LocalServer32` = `"…\psyche-helper.exe" -ToastActivated`, and `HKCU\Software\Classes\AppUserModelId\com.psyche.helper` with `DisplayName` = `Psyche` and `CustomActivator` = the CLSID.
- `--squirrel-updated`: the same for the new version (the helper path changes with every `app-<version>`); the desktop shortcut only if it still exists. The helper keeps its versioned path rather than a copy at a fixed one, which a running helper would lock during an update; the helper rewrites `LocalServer32` itself when it starts but leaves an existing shortcut alone, which is why the hook refreshes both. Squirrel keeps the previous `app-<version>` until the next update, so a toast clicked in between still finds an executable.
- `--squirrel-uninstall`: ends the Gateway's service host, deletes the account's `\Psyche\Gateway-<SID>` task (and a `\Psyche\Gateway` of an earlier version when it runs as this account), ends other `Psyche.exe` and `psyche-helper.exe` processes, removes the three shortcuts, the CLSID and AppUserModelId keys, `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\com.psyche.helper`, the login item (the `Psyche` value that `app.setLoginItemSettings` writes under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, and the one Windows adds under `…\Explorer\StartupApproved\Run` when it is switched off in Task Manager) and the URL handlers `HKCU\Software\Classes\psyche` and `psyche-pair`. `%USERPROFILE%\.psyche` stays.

The Gateway task `\Psyche\Gateway-<user SID>` (at logon; Task Scheduler names are machine-wide, so
the name carries the account's SID: `packages/hostfs/src/gateway-task.ts` and `gateway-task.json`,
which the desktop, the CLI, the uninstall hook and `deploy/windows/install-local.ps1` share) runs
`conhost.exe --headless <node.exe> <service-host.mjs> --home <PSYCHE_HOME> -- <psyched>`: the
service host sets `PSYCHE_HOME`, appends to `$PSYCHE_HOME\logs\gateway.out.log` and `gateway.err.log`,
restarts the Gateway when it exits and records `$PSYCHE_HOME\run\gateway-service.pid` and
`gateway.pid`. `schtasks /End` ends only conhost, so stopping also ends that process tree.
`apps/cli/src/supervisor.ts` renders the task; the bundle's `psyche-gateway.task.xml.template`
is the same XML with `{{PSYCHED_DIR}}`, `{{PSYCHE_HOME}}`, `{{USER_ID}}` (`DOMAIN\user`) and
`{{TASK_NAME}}`, stored UTF-16 as `schtasks /Create /XML` expects. The app and `psyche start` replace
an earlier version's shared `\Psyche\Gateway` when its logon trigger or principal names this
account, and leave another account's alone.

The vault's key-file slot works as on macOS: the app creates `$PSYCHE_HOME\secrets\vault.key`
(owner-only ACL) unless the vault already uses another slot, and writes its path to
`$PSYCHE_HOME\run\gateway-service.json` (`{"vaultKeyFile": …}`, owner-only through
`@psyche/hostfs` `restrictToOwner`). The service host reads that file whenever it starts the
Gateway and sets `PSYCHE_VAULT_KEY_FILE` in the Gateway's environment only, so the path is on no
command line (which any local process can read) and in no other process's environment; the app
restarts the task when the file changes. "Quit Psyche entirely" removes it with the task.

The same file carries the build the app ships (`{"build": …}`, from `resources\psyched\build-info.json`),
which the service host sets as `PSYCHE_BUILD`: the Gateway reports it in the handshake, and when
the Gateway that answers is another build (one left running across an update) the app asks it to
settle (`gateway.prepareUpdate`) and restarts the task, once per build, as it reloads the
LaunchAgent on macOS.

### Updates on Windows

The signed manifest's `platforms["win32-x64"]` lists Squirrel's `RELEASES`, the full nupkg, an
optional delta nupkg (with the `baseVersion` it applies to) and the installer. The updater verifies
the manifest and the SHA-256 of `RELEASES` and the package, checks `RELEASES`' SHA-1 and size lines
against the verified package, and hands Squirrel a local folder with exactly those files
(`Update.exe --update <folder>` through Electron's `autoUpdater`). A delta that fails is retried
once with the verified full package. The new version starts the next time Psyche starts.
`deploy/scripts/update-manifest.mjs build` adds the Windows files given `RELEASES`, the nupkgs and
`Psyche-<version>-Setup.exe` (`--delta-base <version>` names the delta's base); the `artifacts`
list keeps macOS files only, so Mac builds released before Windows support keep updating.

The release workflow (`.github/workflows/release.yml`, job `windows`) builds with
`deploy/windows/build-local.ps1 -Smoke`. When an earlier release has Windows files it downloads that
release's `RELEASES` and full nupkg, serves them on loopback for the build and points
`PSYCHE_SQUIRREL_REMOTE_RELEASES` at `http://127.0.0.1:18765/` (Squirrel's SyncReleases reads only
http(s), not a `file://` URL or a path, and a github.com URL would make it ask the API for the
latest release instead), so Squirrel also makes a delta nupkg; the `release` job then builds the
manifest with `--win-arch x64 --delta-base <that version>`. `build-local.ps1` copies only this
version's nupkgs into `dist\squirrel-win32-x64\`.
