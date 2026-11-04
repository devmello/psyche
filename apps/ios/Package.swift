// swift-tools-version: 6.2
import PackageDescription

// Psyche for iPhone and iPad (docs/design/ios-app-2026.md §2). Every target except the thin app and
// extension mains lives here; the Xcode project (project.yml, XcodeGen) is a generated shell.
// No third-party dependencies (A3). Swift 6 language mode throughout (A4).
//
// Dependency direction (nothing points up):
//   PsycheFeatures -> PsycheBlocks -> PsycheDesign
//   PsycheFeatures -> PsycheClient -> PsycheStore -> PsycheShared
// PsycheClient, PsycheStore and PsycheShared have no UI, so `swift test` runs them on macOS.

let package = Package(
    name: "PsycheKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "PsycheFeatures", targets: ["PsycheFeatures"]),
        .library(name: "PsycheDesign", targets: ["PsycheDesign"]),
        .library(name: "PsycheShared", targets: ["PsycheShared"]),
    ],
    dependencies: [
        // The shared wire layer (generated models, frames, connect signing). Path dependency, no network.
        .package(path: "../../packages/protocol-swift"),
    ],
    targets: [
        // App group paths and the Gateway endpoint: the only module the extensions link.
        .target(name: "PsycheShared"),
        // Snapshot types and the store protocol the UI reads. Fixture implementation only (I2 adds the cache).
        .target(name: "PsycheStore", dependencies: ["PsycheShared"]),
        // Connection states, Session, the Gateway connection, pairing, outbox and `GatewayBackend` (I2).
        .target(
            name: "PsycheClient",
            dependencies: [
                "PsycheStore", "PsycheShared",
                .product(name: "PsycheProtocol", package: "protocol-swift"),
                .product(name: "PsycheWire", package: "protocol-swift"),
            ]
        ),
        // Tokens, type styles and components.
        .target(name: "PsycheDesign", resources: [.process("Resources")]),
        // Native block views and the generative-UI WebView host (I4, I8). Empty for now.
        .target(name: "PsycheBlocks", dependencies: ["PsycheDesign"]),
        .target(
            name: "PsycheFeatures",
            dependencies: ["PsycheBlocks", "PsycheDesign", "PsycheClient", "PsycheStore", "PsycheShared"]
        ),
        .testTarget(name: "PsycheStoreTests", dependencies: ["PsycheStore"]),
        .testTarget(
            name: "PsycheClientTests",
            dependencies: [
                "PsycheClient", "PsycheStore", "PsycheShared",
                .product(name: "PsycheProtocol", package: "protocol-swift"),
                .product(name: "PsycheWire", package: "protocol-swift"),
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)
