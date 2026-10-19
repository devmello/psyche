import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheProtocol
import Security

/// Signs presence assertions (issue #84).
public protocol PresenceSigning: Sendable {
    /// X9.63 uncompressed public key and its `keyId`. Never prompts.
    func publicKey() throws -> (x963: Data, keyId: String)
    /// Runs Touch ID for the key's access control with `reason`, then signs
    /// `PresenceMessage.bytes(challenge)` with the same `LAContext` (one prompt).
    func sign(challenge: String, reason: String) async throws -> PresenceAssertion
}

/// The helper's presence key: one Secure Enclave P-256 key in the data-protection keychain
/// (`kSecAttrTokenIDSecureEnclave`, permanent, this device only, non-synchronizable), access control
/// `[.privateKeyUsage, .biometryCurrentSet]`, so every signature needs a current fingerprint.
/// Like every data-protection keychain item it needs the keychain access group entitlement
/// (provisioning profile); without it the key cannot be created and approvals that need presence
/// stay refused by the Gateway (`presenceError: missing_entitlement`).
///
/// `secureEnclave: false` makes a non-permanent software key with the same algorithm, so tests run
/// the real `SecKey` signing path without a Secure Enclave, Touch ID or entitlements.
public final class PresenceKey: PresenceSigning, @unchecked Sendable {
    public static let tag = Data("com.psyche.helper.presence".utf8)
    static let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256

    private let secureEnclave: Bool
    private let accessGroup: String?
    private let lock = NSLock()
    private var ephemeral: SecKey?

    public init(secureEnclave: Bool = true, accessGroup: String? = KeychainAccessGroup.resolve()) {
        self.secureEnclave = secureEnclave
        self.accessGroup = accessGroup
    }

    static func accessControl() throws -> SecAccessControl {
        var error: Unmanaged<CFError>?
        guard let ac = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error
        ) else { throw Self.failure(error?.takeRetainedValue()) }
        return ac
    }

    // MARK: Key lookup / creation

    private func lookupQuery(context: LAContext?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrApplicationTag as String: Self.tag,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnRef as String: true,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        if let context { q[kSecUseAuthenticationContext as String] = context }
        return q
    }

    /// The private key ref (creating it on first use). Getting the ref never prompts.
    func privateKey(context: LAContext? = nil) throws -> SecKey {
        if !secureEnclave {
            lock.lock()
            defer { lock.unlock() }
            if let ephemeral { return ephemeral }
            var error: Unmanaged<CFError>?
            let attrs: [String: Any] = [
                kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256,
                kSecAttrIsPermanent as String: false,
            ]
            guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else { throw Self.failure(error?.takeRetainedValue()) }
            ephemeral = key
            return key
        }
        var ref: CFTypeRef?
        let status = SecItemCopyMatching(lookupQuery(context: context) as CFDictionary, &ref)
        if status == errSecSuccess, let ref { return (ref as! SecKey) }  // swiftlint:disable:this force_cast
        guard status == errSecItemNotFound else { throw KeychainStatus.error(from: KeychainOSStatusError(status)) }
        var privateAttrs: [String: Any] = [
            kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: Self.tag,
            kSecAttrAccessControl as String: try Self.accessControl(),
        ]
        if let accessGroup { privateAttrs[kSecAttrAccessGroup as String] = accessGroup }
        var attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecAttrSynchronizable as String: false,
            kSecUseDataProtectionKeychain as String: true,
            kSecPrivateKeyAttrs as String: privateAttrs,
        ]
        if let accessGroup { attrs[kSecAttrAccessGroup as String] = accessGroup }
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else { throw Self.failure(error?.takeRetainedValue()) }
        return key
    }

    // MARK: PresenceSigning

    public func publicKey() throws -> (x963: Data, keyId: String) {
        guard let pub = SecKeyCopyPublicKey(try privateKey()) else {
            throw CapabilityError(.errorCodeInternal, reason: "presence_key", "The presence key has no public key")
        }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(pub, &error) as Data? else { throw Self.failure(error?.takeRetainedValue()) }
        return (data, PresenceMessage.keyId(x963: data))
    }

    public func sign(challenge: String, reason: String) async throws -> PresenceAssertion {
        guard PresenceMessage.isValidChallenge(challenge) else {
            throw CapabilityError.invalidParams("presenceChallenge must be 64 hex characters", field: "presenceChallenge")
        }
        var context: LAContext?
        if secureEnclave {
            // Evaluate exactly the key's access control, then sign with that context: one prompt.
            let ctx = LAContext()
            ctx.touchIDAuthenticationAllowableReuseDuration = 0
            do {
                _ = try await ctx.evaluateAccessControl(try Self.accessControl(), operation: .useKeySign, localizedReason: reason)
            } catch {
                throw KeychainStatus.error(from: error)
            }
            context = ctx
        }
        let key = try privateKey(context: context)
        let keyId = try publicKey().keyId
        var error: Unmanaged<CFError>?
        guard let der = SecKeyCreateSignature(key, Self.algorithm, PresenceMessage.bytes(challenge: challenge) as CFData, &error) as Data? else {
            throw Self.failure(error?.takeRetainedValue())
        }
        return PresenceAssertion(signature: Base64URL.encode(der), keyId: keyId)
    }

    static func failure(_ error: CFError?) -> CapabilityError {
        guard let error else { return CapabilityError(.errorCodeInternal, reason: "presence_key", "Presence key operation failed") }
        let code = CFErrorGetCode(error)
        if CFErrorGetDomain(error) as String == NSOSStatusErrorDomain {
            return KeychainStatus.error(from: KeychainOSStatusError(OSStatus(code)))
        }
        return KeychainStatus.error(from: error as Error)
    }
}

/// `presence.public_key` (issue #84): the key the owner registers so the Gateway can verify
/// helper-signed Touch ID approvals. Registration itself is an owner action in the Gateway (S01).
public enum PresenceCapabilities {
    public static func make(key: any PresenceSigning) -> [any CapabilityHandler] {
        [Capability(CapabilitySpec(
            name: "presence.public_key",
            description: "The helper's Secure Enclave presence public key (P-256, X9.63 uncompressed, base64url) and keyId (hex SHA-256 of it). "
                + "Created on first use; never prompts. Fails with unavailable/missing_entitlement in builds without a keychain access group.",
            sideEffect: .read
        )) { _ in
            let (x963, keyId) = try key.publicKey()
            return CapabilityOutput(["publicKey": .string(Base64URL.encode(x963)), "keyId": .string(keyId)])
        }]
    }
}
