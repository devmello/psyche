import CryptoKit
import Foundation
import PsycheProtocol

/// AES-256-GCM wrapping of the vault data-encryption key (DEK) under a key-encryption key (KEK) that
/// lives in the data-protection keychain (security §4.2).
///
/// Blob format v1 (61 bytes, base64url on the wire):
///
///     version (1 byte = 0x01) || nonce (12) || ciphertext (32) || tag (16)
///
/// The associated data is the UTF-8 slot name, so a blob wrapped for one slot does not open under
/// another slot's KEK even if the KEKs were ever equal, and a blob moved between slots is rejected.
public enum KeyWrap {
    public static let version: UInt8 = 1
    /// DEK and KEK size: 256-bit keys only (SQLCipher raw key, AES-256 KEK).
    public static let keyByteCount = 32
    public static let nonceByteCount = 12
    public static let tagByteCount = 16
    /// Total v1 blob size.
    public static let wrappedByteCount = 1 + nonceByteCount + keyByteCount + tagByteCount

    /// Wraps `dek` under `kek` for `slot`. A fresh random nonce is used each call.
    public static func wrap(dek: Data, kek: Data, slot: String) throws(KeyWrapError) -> Data {
        guard dek.count == keyByteCount else { throw .badKeySize(field: "dek", byteCount: dek.count) }
        guard kek.count == keyByteCount else { throw .badKeySize(field: "kek", byteCount: kek.count) }
        do {
            let sealed = try AES.GCM.seal(dek, using: SymmetricKey(data: kek), nonce: AES.GCM.Nonce(), authenticating: Data(slot.utf8))
            var blob = Data([version])
            blob.append(contentsOf: sealed.nonce)
            blob.append(sealed.ciphertext)
            blob.append(sealed.tag)
            return blob
        } catch {
            throw .cryptoFailure
        }
    }

    /// Opens a v1 blob. Throws `.authenticationFailed` for tampering, a wrong KEK or a wrong slot.
    public static func unwrap(_ blob: Data, kek: Data, slot: String) throws(KeyWrapError) -> Data {
        guard kek.count == keyByteCount else { throw .badKeySize(field: "kek", byteCount: kek.count) }
        guard let first = blob.first else { throw .malformed }
        guard first == version else { throw .unsupportedVersion(first) }
        guard blob.count == wrappedByteCount else { throw .malformed }
        let bytes = [UInt8](blob)
        let nonceEnd = 1 + nonceByteCount
        let ctEnd = nonceEnd + keyByteCount
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: bytes[1..<nonceEnd]),
                ciphertext: bytes[nonceEnd..<ctEnd],
                tag: bytes[ctEnd...]
            )
            return try AES.GCM.open(box, using: SymmetricKey(data: kek), authenticating: Data(slot.utf8))
        } catch {
            throw .authenticationFailed
        }
    }

    /// base64url form of `wrap`.
    public static func wrapBase64URL(dek: Data, kek: Data, slot: String) throws(KeyWrapError) -> String {
        Base64URL.encode(try wrap(dek: dek, kek: kek, slot: slot))
    }

    /// Decodes a base64url blob and opens it.
    public static func unwrapBase64URL(_ wrapped: String, kek: Data, slot: String) throws(KeyWrapError) -> Data {
        guard let blob = Base64URL.decode(wrapped) else { throw .malformed }
        return try unwrap(blob, kek: kek, slot: slot)
    }

    /// A fresh random 256-bit KEK.
    public static func generateKEK() -> Data {
        SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    }
}

public enum KeyWrapError: Error, Equatable, Sendable {
    case badKeySize(field: String, byteCount: Int)
    case malformed
    case unsupportedVersion(UInt8)
    case authenticationFailed
    case cryptoFailure

    /// Capability error (never carries key material).
    public var capabilityError: CapabilityError {
        switch self {
        case .badKeySize(let field, let count):
            CapabilityError(
                .invalidParams, reason: "bad_key_size", "\(field) must be \(KeyWrap.keyByteCount) bytes (got \(count))",
                details: ["field": .string(field)]
            )
        case .malformed:
            CapabilityError(.invalidParams, reason: "wrapped_malformed", "The wrapped key is not a valid v1 blob", details: ["field": "wrapped"])
        case .unsupportedVersion(let v):
            CapabilityError(
                .invalidParams, reason: "wrapped_version", "Unsupported wrapped key version \(v)",
                details: ["field": "wrapped", "version": .int(Int(v))]
            )
        case .authenticationFailed:
            CapabilityError(
                .invalidParams, reason: "unwrap_failed",
                "The wrapped key does not open with this slot's key (tampered, wrong slot, or the slot was replaced)",
                details: ["field": "wrapped"]
            )
        case .cryptoFailure:
            CapabilityError(.errorCodeInternal, reason: "crypto_failure", "AES-GCM failed")
        }
    }
}
