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
