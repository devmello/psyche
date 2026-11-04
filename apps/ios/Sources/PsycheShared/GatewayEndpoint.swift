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
    /// The pinned Gateway identity key, base64url raw Ed25519 (43 characters). Empty until the first connect
    /// proves a key that hashes to `linkFingerprint`, and for fixtures.
    public var identityKey: String
    /// The Host's name, "studio-mac".
    public var hostName: String
    /// `sha256:<hex>` of the Gateway key, from the pairing link. Pins the Gateway until `identityKey` is stored.
    public var linkFingerprint: String?
    /// SHA-256 (base64url) of the SPKI of the self-signed certificate a LAN Gateway served when this phone first
    /// connected. Later connections must present the same certificate.
    public var lanCertSpki: String?

    /// An origin the phone may dial: `https://host[:port]`, or `http://` only for exactly `localhost`, `127.0.0.1`
    /// or `::1` (a Gateway on the development machine). No credentials, path, query or fragment. Fixture
    /// endpoints have no origin at all (empty), which is allowed here and never dialed.
    public static func isDialableOrigin(_ origin: String) -> Bool {
        if origin.isEmpty { return true }
        guard let parts = URLComponents(string: origin), let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/"
        else { return false }
        switch scheme {
        case "https": return true
        case "http": return isLoopbackName(host)
        default: return false
        }
    }

    public static func isLoopbackName(_ host: String) -> Bool {
        ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
    }

    public init(
        host: String, fingerprint: String, transport: Transport,
        url: String = "", identityKey: String = "", hostName: String = "",
        linkFingerprint: String? = nil, lanCertSpki: String? = nil
    ) {
        self.linkFingerprint = linkFingerprint
        self.lanCertSpki = lanCertSpki
        self.host = host
        self.fingerprint = fingerprint
        self.transport = transport
        self.url = url
        self.identityKey = identityKey
        self.hostName = hostName
    }
}
