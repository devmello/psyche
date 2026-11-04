# protocol-swift

Shared SwiftPM package for the Apple clients (`apps/mac-helper`, the iOS app). Swift 6, macOS 15 and iOS 26, no third-party dependencies.

| Product | Contents |
| --- | --- |
| `PsycheProtocol` | `PsycheProtocol.generated.swift` (written by `pnpm protocol:gen`, do not edit) and `Frames.swift` (wire frame envelopes) |
| `PsycheWire` | `ConnectSigning` (connect signing payload v1), `Base64URL`, `DeviceIdentity` (Ed25519) |

```sh
swift build && swift test   # in this directory
```

The TypeScript side of the signing payload (v1 and v2) lives in `packages/protocol`; the Swift side implements v1 only so far.
