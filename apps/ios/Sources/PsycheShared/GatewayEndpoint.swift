import Foundation

/// How the phone reaches the Gateway (companion doc §2.2). Comes from the pairing link; `EndpointStore` keeps it.
/// Nothing in here is secret: the identity key is a public key, the device's private key lives in the Keychain.
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
    /// The Gateway's origin from the pairing link: `https://host[:port]`, or `http://` for loopback.
    /// Empty only for fixture endpoints.
    public var url: String
    /// The pinned Gateway identity key, base64url raw Ed25519 (43 characters). Empty only for fixtures.
    public var identityKey: String
    /// The Host's name, "studio-mac".
    public var hostName: String

    public init(
        host: String, fingerprint: String, transport: Transport,
        url: String = "", identityKey: String = "", hostName: String = ""
    ) {
        self.host = host
        self.fingerprint = fingerprint
        self.transport = transport
        self.url = url
        self.identityKey = identityKey
        self.hostName = hostName
    }
}
