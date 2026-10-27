// swift-tools-version: 6.0
// Throwaway spike (spike-06). Not a Psyche package; nothing imports this.
import PackageDescription

let package = Package(
    name: "vzspike",
    platforms: [.macOS("27.0")],
    targets: [
        .executableTarget(
            name: "vzspike",
            path: "Sources/vzspike",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                .linkedFramework("Virtualization"),
                .linkedFramework("DiskImageKit"),
                .linkedFramework("AppKit"),
            ]
        )
    ]
)
