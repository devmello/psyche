import Foundation
import PsycheShared
import PsycheStore
import enum PsycheProtocol.JSONValue

// Settings (§4.7). "This phone" is read from what the phone knows (the pinned endpoint, its own name and the
// scopes the Gateway granted at connect), improved by its own record in `devices.list` when the phone happens
// to hold admin (that method is admin-only, so a normal phone falls back). The toggles are phone-local
// preferences: they live in a protected file in the app group and never go to the Gateway.
extension GatewayBackend {
    public func device() async throws -> DeviceInfo {
        guard let endpoint = await client.pairedEndpoint else { throw BackendError.unreachable }
        let own = await client.ownIdentity
        var name = own.name
        var scopes = own.scopes
        if !own.deviceID.isEmpty,
           let list = await optional({ try await self.call("devices.list", .obj([:])) }),
           let record = list["devices"]?.array?.first(where: { $0["id"]?.string == own.deviceID }) {
            if let recordName = record["name"]?.string, !recordName.isEmpty { name = recordName }
            if let recordScopes = record["scopes"]?.array?.compactMap(\.string) { scopes = recordScopes }
        }
        return DeviceInfo(
            name: name, scopes: Self.scopeLabels(scopes), gatewayHost: endpoint.host,
            gatewayFingerprint: Self.fingerprint(of: endpoint), transport: endpoint.transport.label)
    }

    public func settings() async throws -> PhoneSettings {
        var settings = PhoneSettingsStore(directory: client.dataDirectory).load()
        // Shown as on only while iOS still allows it: a permission switched off in iOS Settings reads as off here.
        if settings.shareLocation { settings.shareLocation = await client.locationSharingAllowed() }
        return settings
    }

    public func updateSettings(_ settings: PhoneSettings) async throws {
        // The location switch has its own call (`setLocationSharing`): it asks iOS, so it never rides along here.
        let store = PhoneSettingsStore(directory: client.dataDirectory)
        var next = settings
        next.shareLocation = store.load().shareLocation
        try store.save(next)
        await client.publishLive(.changed(.settings))
    }

    public func setLocationSharing(_ on: Bool) async throws -> LocationSharingOutcome {
        guard let outcome = await client.setLocationSharing(on) else { throw BackendError.notFound }
        let store = PhoneSettingsStore(directory: client.dataDirectory)
        var saved = store.load()
        saved.shareLocation = outcome == .enabled
        try store.save(saved)
        await client.publishLive(.changed(.settings))
        return outcome
    }

    /// `devices.revokeSelf`, then the wipe (keys, endpoint, outbox, share inbox, caches, saved settings). The UI
    /// moves to `.revoked` only after this returns; when the Gateway cannot be reached or refuses, it throws and
    /// nothing is wiped (`removeThisPhoneLocally` is the owner's separate, warned choice).
    public func revokeThisPhone() async throws {
        try await client.revokeThisDevice()
    }

    /// The wipe without telling the Gateway.
    public func removeThisPhoneLocally() async throws {
        try await client.revoke()
    }

    /// `machines.list`. A Gateway without the registry (or a refused call) shows no list rather than an error.
    public func machines() async throws -> [MachineSummary] {
        guard let result = await optional({ try await self.call("machines.list", .obj([:])) }) else { return [] }
        return Self.machineSummaries(result)
    }

    // MARK: - Mapping

    static func machineSummaries(_ result: JSONValue) -> [MachineSummary] {
        (result["machines"]?.array ?? []).compactMap { m in
            guard let id = m["id"]?.string,
                  let name = m["name"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
            else { return nil }
            // An unknown status reads as offline: never claim a computer is reachable on a guess.
            let status = MachineSummary.Status(rawValue: m["status"]?.string ?? "") ?? .offline
            return MachineSummary(id: id, name: name, status: status)
        }
    }

    /// ["operator.read", "operator.approvals"] -> ["Read", "Approvals"]; a scope this phone doesn't know shows as is.
    static func scopeLabels(_ scopes: [String]) -> [String] {
        scopes.map { scope in
            switch scope {
            case "operator.read": "Read"
            case "operator.write": "Write"
            case "operator.approvals": "Approvals"
            case "operator.admin": "Admin"
            default: scope
            }
        }
    }

    /// "sha256:7F3A 91C2 E04B": the endpoint's grouped fingerprint, as the Mac shows it.
    static func fingerprint(of endpoint: GatewayEndpoint) -> String {
        endpoint.fingerprint.hasPrefix("sha256:") ? endpoint.fingerprint : "sha256:\(endpoint.fingerprint)"
    }
}

/// The phone's own preferences, `settings.json` beside the outbox: written atomically, protected until first
/// unlock, wiped with the rest when the phone is removed.
struct PhoneSettingsStore: Sendable {
    static let fileName = "settings.json"
    static let defaults = PhoneSettings(
        notifications: true, liveActivities: true, taskTitlesOnLockScreen: false)

    let directory: URL?

    private struct Stored: Codable {
        var notifications: Bool?
        var liveActivities: Bool?
        var taskTitlesOnLockScreen: Bool?
        var stayConnectedWhileRunning: Bool?
        var shareLocation: Bool?
    }

    /// What was saved; anything missing (no file, a damaged one, a setting added later) is the default.
    func load() -> PhoneSettings {
        let d = Self.defaults
        guard let directory, let data = try? Data(contentsOf: directory.appendingPathComponent(Self.fileName)),
              let stored = try? JSONDecoder().decode(Stored.self, from: data) else { return d }
        return PhoneSettings(
            notifications: stored.notifications ?? d.notifications, liveActivities: stored.liveActivities ?? d.liveActivities,
            taskTitlesOnLockScreen: stored.taskTitlesOnLockScreen ?? d.taskTitlesOnLockScreen,
            stayConnectedWhileRunning: stored.stayConnectedWhileRunning ?? d.stayConnectedWhileRunning,
            shareLocation: stored.shareLocation ?? d.shareLocation)
    }

    func save(_ settings: PhoneSettings) throws {
        guard let directory else { return }
        try AppGroup.prepareDirectory(directory)
        let stored = Stored(
            notifications: settings.notifications, liveActivities: settings.liveActivities,
            taskTitlesOnLockScreen: settings.taskTitlesOnLockScreen,
            stayConnectedWhileRunning: settings.stayConnectedWhileRunning, shareLocation: settings.shareLocation)
        try JSONEncoder().encode(stored).write(
            to: directory.appendingPathComponent(Self.fileName),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
