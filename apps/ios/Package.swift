// swift-tools-version: 6.2
import PackageDescription

// Psyche for iPhone and iPad (docs/design/ios-app-2026.md §2). Every target except the thin app and
// extension mains lives here; the Xcode project (project.yml, XcodeGen) is a generated shell.
// No third-party dependencies (A3). Swift 6 language mode throughout (A4).
//
// Dependency direction (nothing points up):
//   PsycheFeatures -> PsycheBlocks -> PsycheDesign, PsycheStore
//   PsycheFeatures -> PsycheClient -> PsycheStore -> PsycheShared
// PsycheClient, PsycheStore and PsycheShared have no UI, so `swift test` runs them on macOS.

let package = Package(
    name: "PsycheKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "PsycheFeatures", targets: ["PsycheFeatures"]),
        .library(name: "PsycheDesign", targets: ["PsycheDesign"]),
        .library(name: "PsycheShared", targets: ["PsycheShared"]),
        .library(name: "PsycheBlocks", targets: ["PsycheBlocks"]),
    ],
    targets: [
        // App group paths and the Gateway endpoint: the only module the extensions link.
        .target(name: "PsycheShared"),
        // Snapshot types and the store protocol the UI reads. Fixture implementation only (I2 adds the cache).
        .target(name: "PsycheStore", dependencies: ["PsycheShared"]),
        // Connection states and Session. Fixture driver only (I2 adds the real connection).
        .target(name: "PsycheClient", dependencies: ["PsycheStore", "PsycheShared"]),
        // Tokens, type styles and components.
        .target(name: "PsycheDesign", resources: [.process("Resources")]),
        // Native block views (I4) and the generative-UI WebView host (I8). Blocks read `ChatItem`, so they
        // depend on PsycheStore (which has no UI and no further dependencies, so nothing points up).
        .target(name: "PsycheBlocks", dependencies: ["PsycheDesign", "PsycheStore"]),
        .target(
            name: "PsycheFeatures",
            dependencies: ["PsycheBlocks", "PsycheDesign", "PsycheClient", "PsycheStore", "PsycheShared"]
        ),
        .testTarget(name: "PsycheStoreTests", dependencies: ["PsycheStore", "PsycheShared"]),
        .testTarget(name: "PsycheWidgetTests", dependencies: ["PsycheBlocks", "PsycheStore"]),
        .testTarget(name: "PsycheFeaturesTests", dependencies: ["PsycheFeatures", "PsycheStore"]),
        .testTarget(name: "PsycheBlocksTests", dependencies: ["PsycheBlocks", "PsycheStore"]),
        .testTarget(name: "PsycheClientTests", dependencies: ["PsycheClient", "PsycheStore", "PsycheShared"]),
    ],
    swiftLanguageModes: [.v6]
)
