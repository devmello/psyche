import Foundation

// Settings on the phone (§4.7): this device, notifications, Live Activities, presence. Owner: the
// Memory session (I7). Everything else says "Change this on your Mac". Gateway methods:
// devices.list (own record, admin only; the phone falls back to what it knows), devices.revokeSelf, push.* (M2).

public protocol SettingsBackend: Sendable {
    func device() async throws -> DeviceInfo
    func settings() async throws -> PhoneSettings
    func updateSettings(_ settings: PhoneSettings) async throws
    /// "Remove this phone": `devices.revokeSelf`, then wipe keys, outbox and caches. Required, with no
    /// default: a backend that cannot do it must throw (`BackendError.unreachable`), because the caller moves
    /// `Session` to `.revoked` only after this returns.
    func revokeThisPhone() async throws

    // Additive. It has a default below, so only a backend with something to wipe overrides it.

    /// "Remove from this phone only": wipes keys, outbox and caches without telling the Gateway, for when the
    /// Gateway cannot be reached. The Mac keeps listing the phone until it is removed there.
    func removeThisPhoneLocally() async throws
}

extension SettingsBackend {
    public func removeThisPhoneLocally() async throws {}
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
