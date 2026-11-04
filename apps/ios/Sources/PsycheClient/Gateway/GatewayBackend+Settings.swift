import Foundation
import PsycheStore

// Settings is I7's screen; the Gateway wiring comes later.
extension GatewayBackend {
    public func device() async throws -> DeviceInfo { throw BackendError.unreachable }
    public func settings() async throws -> PhoneSettings { throw BackendError.unreachable }
    public func updateSettings(_ settings: PhoneSettings) async throws { throw BackendError.unreachable }
}
