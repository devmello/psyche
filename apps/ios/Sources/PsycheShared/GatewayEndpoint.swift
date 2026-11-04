import Foundation

/// How the phone reaches the Gateway (companion doc §2.2). Comes from the pairing code; I2 stores it.
public struct GatewayEndpoint: Hashable, Sendable, Codable {
    public enum Transport: String, Hashable, Sendable, Codable {
        case lan
        case tailscale

        public var label: String {
            switch self {
            case .lan: "Home network"
            case .tailscale: "Tailscale"
            }
        }
    }

    public var host: String
    /// The Gateway identity key's fingerprint, grouped for reading: "7F3A 91C2 E04B".
    public var fingerprint: String
    public var transport: Transport

    public init(host: String, fingerprint: String, transport: Transport) {
        self.host = host
        self.fingerprint = fingerprint
        self.transport = transport
    }
}
