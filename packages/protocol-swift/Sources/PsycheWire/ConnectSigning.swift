import CryptoKit
import Foundation

/// `connectSigningPayload` (wire spec v1, security §10) and its v2 form that binds the Gateway identity
/// key (remote-gateway design §3.3). Byte-identical to `packages/protocol` and `apps/desktop/src/lib/signing.ts`.
public enum ConnectSigning {
    /// With `gatewayKey` the payload is v2 (`psyche-connect-v2`, key appended); without it, v1.
    public static func payload(
        nonce: String, platform: String, deviceFamily: String, protocolVersion: Int, serverOrigin: String,
        gatewayKey: String? = nil
    ) -> Data {
        var fields = [
            gatewayKey == nil ? "psyche-connect-v1" : "psyche-connect-v2", nonce, platform, deviceFamily,
            String(protocolVersion), serverOrigin,
        ]
        if let gatewayKey { fields.append(gatewayKey) }
        return Data(fields.joined(separator: "\n").utf8)
    }
}

/// What the Gateway signs with its identity key in a challenge (`gatewaySigningPayload`):
/// `psyche-gateway-v1 \n nonce \n serverOrigin \n devicePublicKey`. The device verifies it.
public enum GatewaySigning {
    public static func payload(nonce: String, serverOrigin: String, devicePublicKey: String) -> Data {
        Data(["psyche-gateway-v1", nonce, serverOrigin, devicePublicKey].joined(separator: "\n").utf8)
    }

    /// True when `signature` (base64url, 64 bytes) is `gatewayKey`'s signature over the payload.
    public static func verify(
        signature: String, gatewayKey: String, nonce: String, serverOrigin: String, devicePublicKey: String
    ) -> Bool {
        guard let keyBytes = Base64URL.decode(gatewayKey), keyBytes.count == 32,
              let sigBytes = Base64URL.decode(signature), sigBytes.count == 64,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes)
        else { return false }
        return key.isValidSignature(
            sigBytes, for: payload(nonce: nonce, serverOrigin: serverOrigin, devicePublicKey: devicePublicKey))
    }
}

/// What the Gateway signs to vouch for the TLS certificate of a LAN connection (`lanCertSigningPayload` in
/// `packages/protocol/src/methods/connect.ts`): `psyche-lan-cert-v1\nnonce\nserverOrigin\ndevicePublicKey\nspki`.
public enum LanCertSigning {
    public static func payload(nonce: String, serverOrigin: String, devicePublicKey: String, spki: String) -> Data {
        Data(["psyche-lan-cert-v1", nonce, serverOrigin, devicePublicKey, spki].joined(separator: "\n").utf8)
    }

    public static func verify(
        signature: String, gatewayKey: String, nonce: String, serverOrigin: String, devicePublicKey: String, spki: String
    ) -> Bool {
        guard let keyBytes = Base64URL.decode(gatewayKey), keyBytes.count == 32,
              let sigBytes = Base64URL.decode(signature), sigBytes.count == 64,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes)
        else { return false }
        return key.isValidSignature(
            sigBytes, for: payload(nonce: nonce, serverOrigin: serverOrigin, devicePublicKey: devicePublicKey, spki: spki))
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
