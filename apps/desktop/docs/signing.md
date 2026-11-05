# Signing and notarizing the desktop app

Builds on a Mac are **ad-hoc signed by default** (CI included); builds on other hosts are
unsigned. Developer ID signing and notarization switch on only when the environment variables
below are set
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

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PSYCHE_SIGN_IDENTITY` | Signing identity, e.g. `Developer ID Application: Jane Doe (TEAMID1234)`. Turns on `osxSign` with the hardened runtime and `entitlements.plist`. A signing failure fails the build. |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Notarization with an App Store Connect API key (preferred). `APPLE_API_KEY` is the path to the `.p8` file. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization with an Apple ID and an app-specific password. Used only when the API key set is incomplete. |

Notarization runs only when signing is on and one of the two credential sets is complete.
Partial sets are ignored.

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
spctl -a -vvv -t exec "$APP"                 # "accepted", "source=Notarized Developer ID"
xcrun stapler validate "$APP"

# Notarization history and the log for a submission:
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

`entitlements.plist` is applied to the app, every Electron helper and the Mach-O files in
`psyched/` (`runtime/node` needs allow-jit under the hardened runtime). `PsycheHelper.app` keeps its own (`apps/mac-helper/Support/PsycheHelper.entitlements`). The app's are:

- `com.apple.security.cs.allow-jit` for V8 under the hardened runtime.
- `com.apple.security.device.audio-input` for dictation, paired with `NSMicrophoneUsageDescription`.

There is no `allow-unsigned-executable-memory` (Electron 44 does not need it) and no
`disable-library-validation`. node-pty's `pty.node` and `spawn-helper` are unpacked from the
asar and signed with the app.

## Fuses

These are flipped at package time: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off,
`EnableNodeCliInspectArguments` off, embedded ASAR integrity on, `OnlyLoadAppFromAsar` on,
`EnableCookieEncryption` on, `LoadBrowserProcessSpecificV8Snapshot` off, and
`GrantFileProtocolExtraPrivileges` off, because the renderer loads from `app://`. Inspect a
build with `npx @electron/fuses read --app "$APP"`.

## Updates: the signed manifest

Code signing makes Squirrel.Mac accept an update; it does not say which update is current or that the zip is the one the release meant. The updater therefore applies an update only after verifying `update-manifest.json` with an Ed25519 release key embedded in the app (`src/main/release-keys.ts`), the downloaded zip's SHA-256, and that it is newer and comes from the pinned release host (security §11, "Update manifest" and "Release key"). The release workflow produces the zip and signs the manifest with `RELEASE_SIGNING_KEY` from the `release` environment; without that secret it publishes no manifest and installed apps do not update. Until the first key is embedded, `startUpdater` returns `no_keys` and does nothing.

## Without a Developer ID: ad-hoc signed DMG

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
`Psyche-<version>-<arch>.dmg.sha256` file is written next to it. With a Developer ID the app is
signed and notarized by `electron-forge package` as above, and the DMG is signed, notarized and
stapled too.

Gatekeeper does not trust an ad-hoc app downloaded from the internet. To open it the first time:

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
maker then signs `Setup.exe` and the `Update.exe` it embeds. In CI (`desktop.yml`, job `windows`)
the PFX comes from the `WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD` secrets, or
Trusted Signing from the `AZURE_*` secrets; without them the job builds unsigned.

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
| Helper toast activator CLSID | `{EA1B5B6E-87ED-48C1-A6C2-89101D0F9D0E}` |

`src/main/squirrel-events.ts` handles Squirrel's events before anything else in `main.ts` starts:

- `--squirrel-install`: `Psyche.lnk` in the Start menu (`%APPDATA%\Microsoft\Windows\Start Menu\Programs`) and on the desktop, both on the stub with the app's AUMID; `Psyche Helper.lnk` in the Start menu on `psyche-helper.exe` with the helper's AUMID and toast activator CLSID; and the activator's COM registration, `HKCU\Software\Classes\CLSID\{…}\LocalServer32` = `"…\psyche-helper.exe" -ToastActivated`.
- `--squirrel-updated`: the same for the new version; the desktop shortcut only if it still exists.
- `--squirrel-uninstall`: ends the Gateway's service host, deletes the `\Psyche\Gateway` task, ends other `Psyche.exe` and `psyche-helper.exe` processes, and removes the three shortcuts and the CLSID key. `%USERPROFILE%\.psyche` stays.

The Gateway task `\Psyche\Gateway` (per user, at logon) runs
`conhost.exe --headless <node.exe> <service-host.mjs> --home <PSYCHE_HOME> -- <psyched>`: the
service host sets `PSYCHE_HOME`, appends to `$PSYCHE_HOME\logs\gateway.out.log` and `gateway.err.log`,
restarts the Gateway when it exits and records `$PSYCHE_HOME\run\gateway-service.pid` and
`gateway.pid`. `schtasks /End` ends only conhost, so stopping also ends that process tree.
`apps/cli/src/supervisor.ts` renders the task; the bundle's `psyche-gateway.task.xml.template`
is the same XML with `{{PSYCHED_DIR}}`, `{{PSYCHE_HOME}}` and `{{USER_ID}}` (`DOMAIN\user`), stored
UTF-16 as `schtasks /Create /XML` expects.

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
