import Foundation

/// Settings' fixture state.
struct SettingsState: Sendable {
    var settings = PhoneSettings(notifications: true, liveActivities: true, taskTitlesOnLockScreen: false, faceIDForApprovals: true)
}

extension FixtureBackend: SettingsBackend {
    public func device() async throws -> DeviceInfo { FixtureData.device }
    public func settings() async throws -> PhoneSettings { settingsState.settings }

    public func updateSettings(_ settings: PhoneSettings) async throws {
        settingsState.settings = settings
        publish(.changed(.settings))
    }
}

extension FixtureData {

    public static let device = DeviceInfo(
        name: "iPhone", scopes: ["Read", "Write", "Approvals"], gatewayHost: "studio-mac.tail3b2c.ts.net",
        gatewayFingerprint: "sha256:7F3A 91C2 E04B", transport: "Tailscale")
}
