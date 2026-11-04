# Psyche for iPhone and iPad

Native SwiftUI, iOS 26 minimum, no third-party dependencies. Architecture and look:
[docs/design/ios-app-2026.md](../../docs/design/ios-app-2026.md). Mockups: `docs/design/ios-app-2026/*.dc.html`.

This is the skeleton (work package I3): the tab shell, the design system, the pairing screens, and
fixture data. The real Gateway client is I2; until then a fake `Session` drives the screens.

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
In the simulator, which has no camera, the scanner offers "Use a sample code" in Debug builds.

## Design tokens

Colors are in `Sources/PsycheDesign/Resources/Colors.xcassets` with light and dark variants
(paper, sheet, rule, hairline, fill, text, muted, ink, inkText, inkSoft, amber, amberText, green, red).
`hairline` and `fill` are the two lighter grays the mockups use for card borders and quiet fills;
`inkText` is ink as text (lighter in dark mode); `inkSoft` is the moth's lower wings.
