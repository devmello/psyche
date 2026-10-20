# Signing and notarizing the desktop app

Builds are **unsigned by default**, and CI always builds unsigned. Developer ID signing and
notarization switch on only when the environment variables below are set
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

## Entitlements

`entitlements.plist` is applied to the app and every helper:

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
`PSYCHE_SIGN_IDENTITY` the package step already signs the app ad-hoc, inside out. If the app it is
given does not pass `codesign --verify --deep --strict` (a build from a host or branch that did not
sign it), the script signs the copy that goes into the DMG ad-hoc itself:

```sh
codesign --force --deep --sign - --entitlements apps/desktop/entitlements.plist Psyche.app
```

That fallback has no hardened runtime, so library validation does not reject the bundled
Gateway's Node runtime and native addons (`Contents/Resources/psyched/`), but `--deep` gives
`Psyche Helper.app` the app's entitlements; the inside-out signing of the package step is the one
to ship. The DMG also
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
