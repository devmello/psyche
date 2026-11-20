// swift-tools-version: 6.0
import Foundation
import PackageDescription

// Psyche Helper (com.psyche.helper): the mac node (architecture §6, §7). Owner: S14.
// SwiftPM builds the executable only; .app bundling, Info.plist, entitlements and signing are S14's
// (placeholders live in Support/).

let protocolProduct = Target.Dependency.product(name: "PsycheProtocol", package: "protocol-swift")
let wireProduct = Target.Dependency.product(name: "PsycheWire", package: "protocol-swift")

let package = Package(
    name: "PsycheHelper",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "psyche-helper", targets: ["PsycheHelper"]),
    ],
    dependencies: [
        // PsycheProtocol (generated models + wire frames) and PsycheWire (connect signing, Base64URL,
        // device identity), shared with the iOS app.
        .package(path: "../../packages/protocol-swift"),
    ],
    targets: [
        // Pure logic (Foundation, CryptoKit, Security only): framing, node runtime, capability
        // registry, AX snapshot building over an abstract tree, tiers, hygiene rules, key wrapping.
        // Everything here is unit-tested without TCC grants.
        .target(name: "PsycheHelperCore", dependencies: [protocolProduct, wireProduct]),
        // Live adapters over Apple frameworks (AX, CGEvent, ScreenCaptureKit, Keychain,
        // UserNotifications, Speech, AVFoundation, Apple Events) and the capability groups.
        .target(name: "PsycheHelperSystem", dependencies: ["PsycheHelperCore", protocolProduct, wireProduct]),
        .executableTarget(name: "PsycheHelper", dependencies: ["PsycheHelperSystem", "PsycheHelperCore", protocolProduct, wireProduct]),
        .testTarget(name: "PsycheHelperCoreTests", dependencies: ["PsycheHelperCore", protocolProduct, wireProduct]),
        .testTarget(name: "PsycheHelperSystemTests", dependencies: ["PsycheHelperSystem", "PsycheHelperCore", protocolProduct, wireProduct]),
    ]
)
