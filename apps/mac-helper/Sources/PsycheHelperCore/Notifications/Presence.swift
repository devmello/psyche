import CryptoKit
import Foundation

/// Presence assertions for Touch ID approvals (issue #84, design-04; security §3.7): the helper's
/// Secure Enclave P-256 key signs `psyche.presence.helper.v1|<presenceChallenge>` with ECDSA
/// (X9.62, SHA-256, DER) after Touch ID. The Gateway verifies it against the owner-registered key
/// (`helperPresenceVerifier` in apps/gateway/src/compose/helper.ts).
public enum PresenceMessage {
    public static let domain = "psyche.presence.helper.v1|"

    /// The bytes the presence key signs.
    public static func bytes(challenge: String) -> Data { Data((domain + challenge).utf8) }

    /// `presenceChallenge` is a hex SHA-256: 64 lowercase or uppercase hex characters.
    public static func isValidChallenge(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) || (65...70).contains($0) }
    }

    /// `keyId`: hex SHA-256 of the X9.63 uncompressed public key.
    public static func keyId(x963 publicKey: Data) -> String {
        SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined()
    }
}

/// `presence` on `notify.response`: base64url DER signature and the key id.
public struct PresenceAssertion: Sendable, Equatable {
    public var signature: String
    public var keyId: String

    public init(signature: String, keyId: String) {
        self.signature = signature
        self.keyId = keyId
    }
}
