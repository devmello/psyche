---
name: psyche-apple
description: Building and testing Psyche's Swift code on this Mac. Covers the Mac helper (apps/mac-helper), the iOS app (apps/ios) and the Swift protocol package (packages/protocol-swift), plus Xcode build locations, the simulator, keychain-safe tests and the free signing limits. Use for any change that touches .swift files, Xcode projects, Live Activities or the helper.
---

# Swift, iOS and the Mac helper

## Before any build

- One Swift or Xcode build at a time on this Mac. Run `pgrep -fl 'swift-build|xcodebuild'` and wait if anything is listed. Other sessions build too.
- The owner's Xcode prefs put DerivedData on `/Volumes/External`, which is often unmounted ("mktemp failed … errno 2"). Fix it inside your worktree, never in the owner's global prefs:
  - **iOS:** after `pnpm ios:project` (xcodegen), write `apps/ios/Psyche.xcodeproj/project.xcworkspace/xcuserdata/$(whoami).xcuserdatad/WorkspaceSettings.xcsettings` with `BuildLocationStyle=CustomLocation`, `CustomBuildLocationType=Absolute`, `CustomBuildIntermediatesPath` and `CustomBuildProductsPath` set to a folder in your worktree, and `DerivedDataLocationStyle=Default`.
  - **Packages:** `swift build` and `swift test` inside the package dir work without it.
- If `xcodebuild` says Xcode needs `sudo xcodebuild -runFirstLaunch`, don't run sudo. Note it in the PR and verify with `swift build` plus unit tests.

## Mac helper (`apps/mac-helper`)

- Run `swift test --filter <Suite>` on the suites you touched, then `swift build`, or use `bash .claude/scripts/verify.sh --swift`.
- Tests must never touch the real login keychain, Touch ID or TCC prompts. Use the injected fakes the existing tests use.
- Never run the built helper against the owner's Gateway, and never signal the owner's running helper.
- The helper follows `$PSYCHE_HOME/run/node-socket` (the Gateway writes it on every start). The code that trusts it is `Paths.swift` (private-directory check, one-descriptor read) and `UnixSocket.swift` (`getpeereid`). The rules for any such trust path are in `psyche-permissions` §4.
- Swift treats `"\r\n"` as one `Character`, so `split(separator: "\n")` never splits a CRLF line. Use `split(whereSeparator: \.isNewline)` (#1308).

## iOS (`apps/ios`)

- Boot one simulator at most, and shut it down when done. It is moderately memory-heavy.
- `Activity.request` is refused while the app is in the background, so a Live Activity can't start from a timer. Start it on resign-active and again on return for anything already past its threshold (`ChatTurnActivityHost`, #1305). To test the background moment: `xcrun simctl launch booted com.apple.mobilesafari`.
- Delete untracked build output (`apps/ios/.build-ios`) before `verify.sh`: biome lints it.
- Free Personal Team signing means no APNs, so Live Activities can't get remote pushes. They must update locally or count on their own, with `Text(timerInterval:)` and `staleDate`.
- Localize every string in `Localizable.xcstrings` in all 10 languages (see `psyche-i18n`).

## Free signing path

Releases are self-signed: no Developer ID, notarization, associated domains, keychain access groups or other provisioning-profile entitlements. Anything needing them (iCloud Keychain passkeys, the data-protection keychain with access groups, APNs) won't work. Choose designs that work unentitled.

## Diagnosing Touch ID and presence reports

Don't guess from "no sheet showed". Read the system log around the approval time: `/usr/bin/log show --last 10m --predicate 'process CONTAINS[c] "coreauth"'`. It shows whether the sheet was shown, the finger was on and it matched. Call it as `/usr/bin/log`: in zsh plain `log` is a builtin. (2026-11-10: settled this way with no code change.)

## Learnings

- 2026-11-10: a Live Activity request from the background fails silently apart from a log line (#1305); a CRLF pointer file read with `split(separator: "\n")` kept its `\r` (#1308).
