# Psyche for iPhone and iPad

Native SwiftUI, iOS 26 minimum, no third-party dependencies. Architecture and look:
[docs/design/ios-app-2026.md](../../docs/design/ios-app-2026.md). Mockups: `docs/design/ios-app-2026/*.dc.html`.

The app runs against the real Gateway (`GatewayBackend`, work package I2) unless launched with
`-psycheScenario <name>`, which uses fixtures. "Try it without a Mac" on the pairing screen also enters
fixture mode. Pair by scanning the code from Settings → Devices → Add phone, or paste the link
(`psyche-pair:v1:…`); the link is read only by the in-app scanner or paste button, never as a URL.

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
