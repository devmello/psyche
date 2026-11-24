---
name: psyche-apple
description: Building and testing Psyche's Swift code on this Mac. Covers the Mac helper (apps/mac-helper), the iOS app (apps/ios) and the Swift protocol package (packages/protocol-swift), plus Xcode build locations, the simulator, keychain-safe tests and the free signing limits. Use for any change that touches .swift files, Xcode projects, Live Activities or the helper.
---

# Swift, iOS and the Mac helper

## Before any build

- One Swift or Xcode build at a time on this Mac. Run `pgrep -x swift-build; pgrep -x xcodebuild; pgrep -x swift-frontend` and wait if anything is listed (`pgrep -fl` false-positives on other shells' command lines). Other sessions build too.
- The owner's Xcode prefs put DerivedData on `/Volumes/External`, which is often unmounted ("mktemp failed … errno 2"). Fix it inside your worktree, never in the owner's global prefs:
  - **iOS:** after `pnpm ios:project` (xcodegen), write `apps/ios/Psyche.xcodeproj/project.xcworkspace/xcuserdata/$(whoami).xcuserdatad/WorkspaceSettings.xcsettings` with `BuildLocationStyle=CustomLocation`, `CustomBuildLocationType=Absolute`, `CustomBuildIntermediatesPath` and `CustomBuildProductsPath` set to a folder in your worktree, and `DerivedDataLocationStyle=Default`.
  - **Packages:** `swift build` and `swift test` inside the package dir work without it.
- If `xcodebuild` says Xcode needs `sudo xcodebuild -runFirstLaunch`, don't run sudo. Note it in the PR and verify with `swift build` plus unit tests.

## Mac helper (`apps/mac-helper`)

- Run `swift test --filter <Suite>` on the suites you touched, then `swift build`, or use `bash .claude/scripts/verify.sh --swift`.
- `verify.sh --swift` covers three packages: `apps/mac-helper` (build and test), `packages/protocol-swift` (build and test), and `apps/ios` (`swift test` of the iOS package's test targets, no simulator, no UI tests). The iOS step runs when the branch touches `apps/ios/` or `packages/protocol-swift/`, and it waits for any other Swift or Xcode build first.
- Tests must never touch the real login keychain, Touch ID or TCC prompts. Use the injected fakes the existing tests use.
- Never run the built helper against the owner's Gateway, and never signal the owner's running helper.
- The helper follows `$PSYCHE_HOME/run/node-socket` (the Gateway writes it on every start). The code that trusts it is `Paths.swift` (private-directory check, one-descriptor read) and `UnixSocket.swift` (`getpeereid`). The rules for any such trust path are in `psyche-permissions` §4.
- Swift treats `"\r\n"` as one `Character`, so `split(separator: "\n")` never splits a CRLF line. Use `split(whereSeparator: \.isNewline)` (#1308).

## iOS (`apps/ios`)

- Boot one simulator at most, and shut it down when done. It is moderately memory-heavy.
- `Activity.request` is refused while the app is in the background, so a Live Activity can't start from a timer. Start it on resign-active and again on return for anything already past its threshold (`ChatTurnActivityHost`, #1305). To test the background moment: `xcrun simctl launch booted com.apple.mobilesafari`.
- **Fixtures with every backend method.** A new backend method or a model field that gates UI (Edit buttons, a screen) gets a `FixtureBackend` implementation with plausible data in the same PR. The protocol default that throws `notFound` leaves demo mode (`-psycheScenario live`) showing "Couldn't load this" and hidden buttons (#1553-#1557: `memoryFiles`, `memoryFile`, `entityKind`, `updateEntity`, person/project `card`).
- **Validation shows late.** Show a field error only after that field was edited, or on Save, and keep Save disabled meanwhile. A red error on an untouched new form (automation editor, #1556) reads as broken.
- **Simulator etiquette.** If the simulator tool says another session uses a device, pick a different one; never more than one per agent. Demo mode is `-psycheScenario live` (debug-only, `apps/ios/App/PsycheApp.swift:23-28`). Build with `CODE_SIGNING_ALLOWED=NO` and `-derivedDataPath` inside your worktree.
- **SwiftUI layout traps (#1580 R1, #1588, #1586, #1606 search screen).** (a) A `.task` on a `Group` that renders nothing never runs: keep a section that loads its own data always present (a `VStack`). (b) A `@ViewBuilder` func returning several sibling views inside a `ZStack` (crossfade container) stacks them on top of each other: wrap them in a `VStack`. (c) A filled `TextField` hides its placeholder, so a placeholder-as-label leaves bare numbers in a `Form`: use `LabeledContent(label) { TextField(...) }`, trailing aligned.
- **Simulator deep links.** `-psycheOpen overview` then the Running row reaches `TaskRunView`; `-psycheOpen task/<id>` only opens the agent sheet; `-psycheOpen people/<id>` opens a person (`Router.swift`). The first screenshot after a launch is often the springboard: wait and retake.
- Delete untracked build output (`apps/ios/.build-ios*`, also `.build-ios-pkg`) before `verify.sh`: biome lints it. `git status` before every `git add`: #1611 committed 645 KB of it, so `.gitignore` now covers `.build-ios*/`.
- Free Personal Team signing means no APNs, so Live Activities can't get remote pushes. They must update locally or count on their own, with `Text(timerInterval:)` and `staleDate`.
- Localize every string in `Localizable.xcstrings` in all 10 languages, with `bundle: .module` in package targets (see `psyche-i18n`).
- U+0085 (NEL) and C1 controls are real line breaks in iOS text layout; see `psyche-permissions` §3b for approval text.

## Free signing path

Releases are self-signed: no Developer ID, notarization, associated domains, keychain access groups or other provisioning-profile entitlements. Anything needing them (iCloud Keychain passkeys, the data-protection keychain with access groups, APNs) won't work. Choose designs that work unentitled.

## Diagnosing Touch ID and presence reports

Don't guess from "no sheet showed". Read the system log around the approval time: `/usr/bin/log show --last 10m --predicate 'process CONTAINS[c] "coreauth"'`. It shows whether the sheet was shown, the finger was on and it matched. Call it as `/usr/bin/log`: in zsh plain `log` is a builtin. (2026-11-10: settled this way with no code change.)

## Learnings

- 2026-11-23: git auto-merges parallel iOS PRs textually, not semantically: two PRs that each added `self.store = store` to the same init merged into a duplicate assignment. After merging `origin/main` into an iOS branch, and after any merge of two iOS PRs, run `swift build` (`verify.sh --swift`) before reporting or merging more (#1542/#1543 pair).
- 2026-11-19: when a Swift app-path rule narrows, probe all installed bundle ids read-only (LaunchServices queries, never launch or `lsregister`) and test cryptex (Safari) and CoreServices (Shortcuts Events) paths; put such lookups behind injected `AppLaunchPolicy.Lookups` (#1427 rounds 1-3).
- 2026-11-10: a Live Activity request from the background fails silently apart from a log line (#1305); a CRLF pointer file read with `split(separator: "\n")` kept its `\r` (#1308).
