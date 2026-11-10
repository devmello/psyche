# Psyche for iPhone and iPad

Native SwiftUI, iOS 26 minimum, no third-party dependencies. Architecture and look:
[docs/design/ios-app-2026.md](../../docs/design/ios-app-2026.md). Mockups: `docs/design/ios-app-2026/*.dc.html`.

The app runs against the real Gateway (`GatewayBackend`, work package I2) unless launched with
`-psycheScenario <name>`, which uses fixtures. "Try it without a Mac" on the pairing screen also enters
fixture mode. Pair by scanning the code from Settings → Server & remote access → Pair another computer, or paste the link
(`psyche-pair:v1:…`); the link is read only by the in-app scanner or paste button, never as a URL. It names the
Gateway by the `sha256:` fingerprint of its identity key (not the key) and carries a one-time setup token, and the
parser follows `packages/protocol/src/pairing-link.ts` rule for rule (https only, never loopback, no extra fields).
The phone pins the key the Gateway proves when it hashes to that fingerprint. On the home network the Gateway's
certificate is self-signed: the phone accepts it only for an address that is not a Tailscale name (`*.ts.net`), only if the system does not trust it, and only after the identity key
signed that certificate's SPKI into the challenge (`lanCertSpki`, `lanCertSignature`); later connections must present
the same certificate.

## Build

```sh
brew install xcodegen
pnpm ios:project                 # generates apps/ios/Psyche.xcodeproj (gitignored)
open apps/ios/Psyche.xcodeproj
```

The simulator needs no signing and no config. For a real phone, copy
`Config/Owner.example.xcconfig` to `Config/Owner.xcconfig` (gitignored) and set your team id and a
bundle id of your own, then run `pnpm ios:project` again.

Command line:

```sh
cd apps/ios && xcodegen generate
xcodebuild -project Psyche.xcodeproj -scheme Psyche -destination 'generic/platform=iOS Simulator' build
swift test        # PsycheStore and PsycheClient, on macOS
```

## Run on your own iPhone with a free Apple ID

You do not need the paid Apple Developer Program to run Psyche on your own phone.

1. **Personal Team.** In Xcode, Settings > Accounts, sign in with your Apple ID. Xcode creates a "Personal Team" for you. Its team id is the 10-character code shown next to it (also in the signing section of any target).
2. **`Config/Owner.xcconfig`.** `cp Config/Owner.example.xcconfig Config/Owner.xcconfig`, then set `PSYCHE_TEAM_ID` to that team id and `PSYCHE_BUNDLE_ID` to a bundle id nobody else has, for example `com.yourname.psyche`. A free team cannot reuse `com.psyche.ios`. The extensions and the app group are derived from this value. Run `pnpm ios:project` again.
3. **Developer Mode.** On the phone: Settings > Privacy & Security > Developer Mode > on, then restart. Connect the phone, pick it as the run destination and press Run.
4. **Trust the certificate.** The first launch says the developer is not trusted. Open Settings > General > VPN & Device Management, tap your Apple ID under "Developer App" and choose Trust.
5. **Re-sign every 7 days.** A free profile expires after 7 days and the app stops opening. Run it from Xcode again (no data is lost) before then. A free team may also sign at most 3 apps and a handful of new app ids per week.

What works on a free account: pairing, chat, approvals in the app, the share sheet, widgets, **Live Activities and the Dynamic Island**, and **local notifications**. Psyche drives those itself from its live Gateway connection while it is open, plus a short background check iOS grants now and then (an app refresh, usually a few times a day, never guaranteed). Tapping Approve or Deny on a notification asks iOS to unlock first, then connects to your Mac for a few seconds; if the Mac cannot be reached the notification becomes "Reconnect to answer" and nothing is queued.

**Live Activities keep moving without push.** Elapsed time uses `Text(timerInterval:)`, so it counts by itself. Every update carries a stale date (4 minutes while the app is not awake, 12 while it is, moved forward before it passes); once stale, the card and island say "May be out of date · open Psyche" and never show Approve or Deny. Progress is only what the Gateway reports: its step count, and an estimated end if it ever sends one (it does not yet). **Settings > Background > "Stay connected while a task runs"** (off by default) holds a silent, mixable audio session (`audio` background mode, no entitlement needed) and the one Gateway connection only while a watched task runs or waits. It stops when nothing watched is running, on Low Power Mode, under 20% battery unplugged, after 3 hours (the activity then goes stale), or after 10 minutes with the Gateway unreachable. Awake time per day is shown in Settings. **Never ship this to a store:** keeping the app alive with a silent audio loop breaks App Store Review Guideline 2.5.4, so remove `SystemSilentAudio` and `audio` from `UIBackgroundModes` before any TestFlight or App Store build (fine for your own phone on a free team). Rules: `StayAwakePolicy.swift`; battery cost and real background behaviour need a physical iPhone to judge.

**Long chat replies get a Live Activity too.** When a reply has been streaming or working for about 20 seconds (the Gateway's `run.updated`, `chat.delta` and tool-call events say so; a task's own run does not count), Psyche starts one activity for that chat: the chat title, a self-moving timer (`Text(timerInterval:)`) and the latest short status. It ends with a brief "Reply ready" (or "Reply failed") when the run ends. One per chat; a chat whose task already has its own activity gets none. Titles and status lines follow the same privacy rule as task activities (only with "Task titles on the Lock Screen", or while unlocked), the stale dates are the same, and the "Stay connected" switch keeps the app awake for them too. If you leave the app (Home, app switcher) before then, the activity starts at that moment, because iOS refuses a start from the background; coming back mid-reply starts one for a reply already past the threshold. Debug builds: `-psycheChatTurnSeconds 4` shortens the 20 seconds. Code: `ChatTurnTracker`, `AlertCenter+ChatTurns.swift`, `ChatTurnLiveActivity.swift`.

What needs the paid account ($99 a year): **Gateway push while the app is closed** (APNs with your own key, push-updated Live Activities, push-to-start, lock-screen answers that arrive within seconds), the notification service extension's decryption, and TestFlight. See `docs/design/mobile-companion-2026.md` section 3.

## Layout

| Path | What |
| --- | --- |
| `project.yml` | XcodeGen spec: the app and four extensions (`NotificationService`, `Share`, `Widgets`, `Intents`), thin shells over the package |
| `Package.swift` | `PsycheShared`, `PsycheStore`, `PsycheClient`, `PsycheDesign`, `PsycheBlocks`, `PsycheFeatures` |
| `App/` | `@main` |
| `Extensions/` | extension mains |
| `Config/` | `Base.xcconfig`, `Owner.example.xcconfig` |

## Trying the states

`FixtureSessionDriver` reads a launch argument, so the connection states can be seen without a Gateway:

```sh
xcrun simctl launch booted com.psyche.ios -psycheScenario live
```

Scenarios: `unpaired` (default), `pending`, `live`, `away`, `gatewayOff`, `tailscaleOff`, `mismatch`.
The simulator has no camera: paste a link (`xcrun simctl pbcopy booted`, then Paste) or use "Try it without a Mac".

## Tests

`swift test` runs the store and client tests on macOS. `LiveGatewayTests` starts a real Gateway from the
repo (`tests/integration/ios-gateway/serve.ts`, scripted model, temporary `PSYCHE_HOME`) and is skipped when
`node` or `pnpm install` is missing, or with `PSYCHE_IOS_SKIP_LIVE=1`.

## Design tokens

Colors are in `Sources/PsycheDesign/Resources/Colors.xcassets` with light and dark variants
(paper, sheet, rule, hairline, fill, text, muted, ink, inkText, inkSoft, amber, amberText, green, red).
`hairline` and `fill` are the two lighter grays the mockups use for card borders and quiet fills;
`inkText` is ink as text (lighter in dark mode); `inkSoft` is the moth's lower wings.
