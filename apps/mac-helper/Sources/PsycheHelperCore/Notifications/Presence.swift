import CryptoKit
import Foundation

/// Presence assertions for approvals (security §3.7). The helper shows the system's owner sheet
/// (`LAContext` `.deviceOwnerAuthentication`: Touch ID, or the Mac login password), and only after
/// the owner passed it signs `psyche.presence.helper.v1|<presenceChallenge>` with its own Ed25519
/// device identity key (64-byte raw signature, base64url). The Gateway verifies that against the
/// public key the device paired with (`helperPresenceVerifier` in apps/gateway/src/compose/helper.ts).
/// The sheet is the proof the owner was there; the signature only proves the genuine, paired helper
/// is the one that answered.
public enum PresenceMessage {
    public static let domain = "psyche.presence.helper.v1|"

    /// The bytes the device key signs.
    public static func bytes(challenge: String) -> Data { Data((domain + challenge).utf8) }

    /// `presenceChallenge` is a hex SHA-256: 64 lowercase or uppercase hex characters.
    public static func isValidChallenge(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) || (65...70).contains($0) }
    }

    /// `keyId`: hex SHA-256 of the 32-byte raw Ed25519 public key.
    public static func keyId(publicKey: Data) -> String {
        SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined()
    }
}

/// `presence` on `notify.response`: base64url Ed25519 signature and the key id.
public struct PresenceSignature: Sendable, Equatable {
    public var signature: String
    public var keyId: String

    public init(signature: String, keyId: String) {
        self.signature = signature
        self.keyId = keyId
    }
}
