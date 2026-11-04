// swift-tools-version: 6.0
import PackageDescription

// Shared Swift wire layer for every Apple client (apps/mac-helper, the iOS app). No third-party
// dependencies; everything builds in Swift 6 language mode.
//
// - PsycheProtocol: generated Codable models (packages/protocol codegen writes
//   Sources/PsycheProtocol/PsycheProtocol.generated.swift; never edit it) plus the hand-written
//   wire frame envelopes.
// - PsycheWire: platform-neutral wire helpers (connect signing payload, Base64URL, the Ed25519
//   device identity). Foundation and CryptoKit only.
let package = Package(
    name: "PsycheProtocolSwift",
    platforms: [.macOS(.v15), .iOS("26.0")],
    products: [
        .library(name: "PsycheProtocol", targets: ["PsycheProtocol"]),
        .library(name: "PsycheWire", targets: ["PsycheWire"]),
    ],
    targets: [
        .target(name: "PsycheProtocol"),
        .target(name: "PsycheWire"),
        .testTarget(name: "PsycheWireTests", dependencies: ["PsycheWire", "PsycheProtocol"]),
    ],
    swiftLanguageModes: [.v6]
)
