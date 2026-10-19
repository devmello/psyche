// swift-tools-version: 6.0
import PackageDescription

// Psyche Helper (com.psyche.helper): the mac node (architecture §6, §7). Owner: S14.
// SwiftPM builds the executable only; .app bundling, Info.plist, entitlements and signing are S14's
// (placeholders live in Support/).
let package = Package(
    name: "PsycheHelper",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "psyche-helper", targets: ["PsycheHelper"]),
        .library(name: "PsycheProtocol", targets: ["PsycheProtocol"]),
    ],
    targets: [
        // Generated models (packages/protocol codegen, post-processed to be Sendable-clean) plus
        // hand-written wire envelopes. Everything builds in Swift 6 language mode.
        .target(name: "PsycheProtocol"),
        .target(name: "PsycheHelperCore", dependencies: ["PsycheProtocol"]),
        .executableTarget(name: "PsycheHelper", dependencies: ["PsycheHelperCore"]),
        .testTarget(name: "PsycheHelperCoreTests", dependencies: ["PsycheHelperCore", "PsycheProtocol"]),
    ]
)
