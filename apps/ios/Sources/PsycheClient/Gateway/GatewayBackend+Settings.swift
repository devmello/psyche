import Foundation
import PsycheStore

// Settings is I7's screen; the Gateway wiring comes later. Removing this phone is live.
extension GatewayBackend {
    public func device() async throws -> DeviceInfo { throw BackendError.unreachable }
    public func settings() async throws -> PhoneSettings { throw BackendError.unreachable }
    public func updateSettings(_ settings: PhoneSettings) async throws { throw BackendError.unreachable }

    /// `devices.revoke` for this phone's own device, then the wipe (keys, endpoint, outbox, share inbox, caches).
    /// The UI moves to `.revoked` only after this returns; when the Gateway cannot be reached or refuses, it throws
    /// and nothing is wiped.
    public func revokeThisPhone() async throws {
        try await client.revokeThisDevice()
    }
}
