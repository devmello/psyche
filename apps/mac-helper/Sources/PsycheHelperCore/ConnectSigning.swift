import CryptoKit
import Foundation

/// `connectSigningPayload` (wire spec v1, security §10). Byte-identical to
/// `packages/protocol` and `apps/desktop/src/lib/signing.ts`.
public enum ConnectSigning {
    public static func payload(
        nonce: String, platform: String, deviceFamily: String, protocolVersion: Int, serverOrigin: String
    ) -> Data {
        let text = ["psyche-connect-v1", nonce, platform, deviceFamily, String(protocolVersion), serverOrigin]
            .joined(separator: "\n")
        return Data(text.utf8)
    }
}

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ text: String) -> Data? {
        var b64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64.append("=") }
        return Data(base64Encoded: b64)
    }
}

/// Ed25519 device identity. In memory only for the bootstrap; S14 moves it to the data-protection
/// keychain (security §4, §12).
public struct DeviceIdentity: Sendable {
    public let privateKey: Curve25519.Signing.PrivateKey

    public init(privateKey: Curve25519.Signing.PrivateKey = .init()) {
        self.privateKey = privateKey
    }

    /// base64url raw 32-byte public key.
    public var publicKey: String { Base64URL.encode(privateKey.publicKey.rawRepresentation) }

    /// `dev_` + first 22 base64url chars of SHA-256(raw public key), as the desktop derives it.
    public var deviceId: String {
        let digest = Data(SHA256.hash(data: privateKey.publicKey.rawRepresentation))
        return "dev_" + Base64URL.encode(digest).prefix(22)
    }

    public func sign(_ payload: Data) throws -> String {
        Base64URL.encode(try privateKey.signature(for: payload))
    }
}
