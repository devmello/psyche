import Foundation

// Settings on the phone (§4.7): this device, notifications, Live Activities, presence. Owner: the
// Memory session (I7). Everything else says "Change this on your Mac". Gateway methods:
// devices.list (own record), devices.revoke (self), push.* (M2).

public protocol SettingsBackend: Sendable {
    func device() async throws -> DeviceInfo
    func settings() async throws -> PhoneSettings
    func updateSettings(_ settings: PhoneSettings) async throws
    /// "Remove this phone" (devices.revoke on itself). The caller then moves `Session` to `.revoked`.
    func revokeThisPhone() async throws
}

extension SettingsBackend {
    // Additive: backends written before this existed treat removal as done locally.
    public func revokeThisPhone() async throws {}
}

public struct DeviceInfo: Sendable, Equatable {
    public var name: String
    /// "Read, write, approvals".
    public var scopes: [String]
    public var gatewayHost: String
    /// "sha256:7F3A 91C2 E04B".
    public var gatewayFingerprint: String
    /// "Tailscale" or "Home network".
    public var transport: String
    public init(name: String, scopes: [String], gatewayHost: String, gatewayFingerprint: String, transport: String) {
        self.name = name
        self.scopes = scopes
        self.gatewayHost = gatewayHost
        self.gatewayFingerprint = gatewayFingerprint
        self.transport = transport
    }
}

public struct PhoneSettings: Sendable, Equatable {
    public var notifications: Bool
    public var liveActivities: Bool
    public var taskTitlesOnLockScreen: Bool
    public var faceIDForApprovals: Bool
    public init(notifications: Bool, liveActivities: Bool, taskTitlesOnLockScreen: Bool, faceIDForApprovals: Bool) {
        self.notifications = notifications
        self.liveActivities = liveActivities
        self.taskTitlesOnLockScreen = taskTitlesOnLockScreen
        self.faceIDForApprovals = faceIDForApprovals
    }
}
