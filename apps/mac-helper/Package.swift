// swift-tools-version: 6.0
import Foundation
import PackageDescription

// Psyche Helper (com.psyche.helper): the mac node (architecture §6, §7). Owner: S14.
// SwiftPM builds the executable only; .app bundling, Info.plist, entitlements and signing are S14's
// (placeholders live in Support/).

// The Secure Enclave file-key fallback for builds without a provisioning profile (security §10) is
// for development only: the release workflow sets PSYCHE_PUBLIC_RELEASE=1, which leaves it out.
// RELEASE BLOCKER (docs/08-roadmap.md v1.0): a provisioned keychain key replaces it before release.
let publicRelease = ProcessInfo.processInfo.environment["PSYCHE_PUBLIC_RELEASE"] == "1"
let presenceSettings: [SwiftSetting] = publicRelease ? [] : [.define("PSYCHE_PRESENCE_FILE_FALLBACK")]

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
        // Pure logic (Foundation, CryptoKit, Security only): framing, node runtime, capability
        // registry, AX snapshot building over an abstract tree, tiers, hygiene rules, key wrapping.
        // Everything here is unit-tested without TCC grants.
        .target(name: "PsycheHelperCore", dependencies: ["PsycheProtocol"]),
        // Live adapters over Apple frameworks (AX, CGEvent, ScreenCaptureKit, Keychain,
        // UserNotifications, Speech, AVFoundation, Apple Events) and the capability groups.
        .target(name: "PsycheHelperSystem", dependencies: ["PsycheHelperCore", "PsycheProtocol"], swiftSettings: presenceSettings),
        .executableTarget(name: "PsycheHelper", dependencies: ["PsycheHelperSystem", "PsycheHelperCore", "PsycheProtocol"]),
        .testTarget(name: "PsycheHelperCoreTests", dependencies: ["PsycheHelperCore", "PsycheProtocol"]),
        .testTarget(name: "PsycheHelperSystemTests", dependencies: ["PsycheHelperSystem", "PsycheHelperCore", "PsycheProtocol"]),
    ]
)
