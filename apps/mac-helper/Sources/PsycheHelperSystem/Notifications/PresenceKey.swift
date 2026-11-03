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
    func sign(challenge: String, reason: String) async throws -> PresenceSignature
    /// Where the key lives (keychain unless overridden); reported by `presence.public_key`.
    var keyKind: PresenceKeyKind { get }
}

/// The Mac's Touch ID enrollment as an opaque hash (`LAContext.domainState.biometry.stateHash`):
/// it changes when a fingerprint is added or removed, which is exactly what makes a
/// `.biometryCurrentSet` key unusable. Recorded when a key is created, compared before each
/// signature, so a dead key is reported (`presence_key_invalidated`) and replaced instead of failing
/// every approval with no reason.
public protocol BiometryStateSource: Sendable {
    func current() -> Data?
}

public struct LiveBiometryState: BiometryStateSource {
    public init() {}
    public func current() -> Data? {
        let ctx = LAContext()
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else { return nil }
        return ctx.domainState.biometry.stateHash
    }
}

public enum PresenceKeyErrors {
    /// The fingerprints changed since the key was made: it can never sign again. The helper has
    /// deleted it; the next `presence.public_key` makes a new one, which the owner registers again
    /// (security §10, recovery).
    public static let invalidated = CapabilityError(
        .unavailable, reason: "presence_key_invalidated",
        "Touch ID changed since this key was set up, so it can no longer sign. Set up Touch ID again in Settings → Devices."
    )
}

/// The helper's presence key: one Secure Enclave P-256 key in the data-protection keychain
/// (`kSecAttrTokenIDSecureEnclave`, permanent, this device only, non-synchronizable), access control
/// `[.privateKeyUsage, .biometryCurrentSet]`, so every signature needs a current fingerprint.
/// Like every data-protection keychain item it needs the keychain access group entitlement
/// (provisioning profile); without it the key cannot be created (`missing_entitlement`) and the
/// helper uses `EnclaveFilePresenceKey` instead (`PreferredPresenceKey`).
///
/// `secureEnclave: false` makes a non-permanent software key with the same algorithm, so tests run
/// the real `SecKey` signing path without a Secure Enclave, Touch ID or entitlements.
public final class PresenceKey: PresenceSigning, @unchecked Sendable {
    public static let tag = Data("com.psyche.helper.presence".utf8)
    static let algorithm = SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256

    private let secureEnclave: Bool
    private let accessGroup: String?
    private let biometry: any BiometryStateSource
    private let lock = NSLock()
    private var ephemeral: SecKey?
    private var ephemeralState: Data?

    /// Labels the key with the enrollment state it was made under (`kSecAttrLabel`).
    static let labelPrefix = "psyche-presence|"

    public init(
        secureEnclave: Bool = true, accessGroup: String? = KeychainAccessGroup.resolve(),
        biometry: any BiometryStateSource = LiveBiometryState()
    ) {
        self.secureEnclave = secureEnclave
        self.accessGroup = accessGroup
        self.biometry = biometry
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
            ephemeralState = biometry.current()
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
        if let state = biometry.current() { privateAttrs[kSecAttrLabel as String] = Self.labelPrefix + Base64URL.encode(state) }
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

    /// The enrollment state the key was made under, when it was recorded. Never prompts.
    func recordedState() -> Data? {
        if !secureEnclave { return lock.withLock { ephemeralState } }
        var q = lookupQuery(context: nil)
        q.removeValue(forKey: kSecReturnRef as String)
        q[kSecReturnAttributes as String] = true
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let label = (out as? [String: Any])?[kSecAttrLabel as String] as? String,
              label.hasPrefix(Self.labelPrefix)
        else { return nil }
        return Base64URL.decode(String(label.dropFirst(Self.labelPrefix.count)))
    }

    /// Deletes a key the enrollment change made unusable, so the next use makes a new one.
    func discardInvalidated() {
        if !secureEnclave {
            lock.withLock {
                ephemeral = nil
                ephemeralState = nil
            }
            return
        }
        var q = lookupQuery(context: nil)
        q.removeValue(forKey: kSecReturnRef as String)
        SecItemDelete(q as CFDictionary)
    }

    public func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        guard PresenceMessage.isValidChallenge(challenge) else {
            throw CapabilityError.invalidParams("presenceChallenge must be 64 hex characters", field: "presenceChallenge")
        }
        // Before any prompt: a key made under other fingerprints can never sign again.
        _ = try privateKey()
        if let recorded = recordedState(), let now = biometry.current(), recorded != now {
            discardInvalidated()
            throw PresenceKeyErrors.invalidated
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
        return PresenceSignature(signature: Base64URL.encode(der), keyId: keyId)
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

/// `presence.confirm` parameters: the approval's presence challenge, its one-line summary and the
/// short code the card shows next to Touch ID (derived from the binding hash), both named in the
/// Touch ID sheet so the owner can tell which approval they confirm.
public struct PresenceConfirmParams: Codable, Sendable, Equatable {
    public var challenge: String
    public var summary: String
    public var code: String

    public init(challenge: String, summary: String, code: String) {
        self.challenge = challenge
        self.summary = summary
        self.code = code
    }
}

/// `presence.public_key` (issue #84): the key the owner registers so the Gateway can verify
/// helper-signed Touch ID approvals. Registration itself is an owner action in the Gateway (S01).
///
/// `presence.confirm`: Touch ID and a signature over one approval's presence challenge, for an
/// approval the owner allowed in the Psyche window (the window cannot sign; the Gateway asks the
/// helper). The Gateway never lets `nodes.invoke` or an agent tool reach `presence.*`, so only
/// it chooses the challenge, and the sheet's wording is fixed here around the card header.
public enum PresenceCapabilities {
    public static let maxSummary = 100

    /// `xxxx-xxxx`, lower-case hex: the approval code the card shows.
    static func isValidCode(_ s: String) -> Bool {
        let parts = s.split(separator: "-", omittingEmptySubsequences: false)
        return parts.count == 2 && parts.allSatisfy { p in
            p.utf8.count == 4 && p.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
    }

    /// What the Touch ID sheet says after "psyche-helper is trying to": fixed wording around the
    /// approval's one-line summary and its code.
    static func confirmReason(summary: String, code: String) -> String {
        let oneLine = summary.split(whereSeparator: \.isNewline).joined(separator: " ")
            .filter { !$0.isASCII || $0.asciiValue.map { $0 >= 0x20 && $0 != 0x7F } == true }
        return "approve \u{201C}\(NotificationLimits.truncate(oneLine, max: maxSummary))\u{201D} (code \(code)) in Psyche"
    }

    public static func make(key: any PresenceSigning) -> [any CapabilityHandler] {
        [publicKey(key), confirm(key)]
    }

    static func confirm(_ key: any PresenceSigning) -> Capability {
        Capability(CapabilitySpec(
            name: "presence.confirm",
            description: "Runs Touch ID for the presence key and signs one approval's presence challenge (an approval allowed in the Psyche window). "
                + "Returns signature (DER, base64url) and keyId. Fails cancelled/user_cancelled when the owner cancels, unavailable/presence_key_invalidated when the fingerprints changed since the key was made.",
            sideEffect: .write,
            inputSchema: Schema.object(
                [
                    "challenge": Schema.string("Hex SHA-256 presence challenge of the approval", maxLength: 64),
                    "summary": Schema.string("The approval's one-line summary, named in the Touch ID sheet", maxLength: maxSummary * 4),
                    "code": Schema.string("The approval code the card shows (xxxx-xxxx hex)", maxLength: 9),
                ],
                required: ["challenge", "summary", "code"]
            )
        )) { ctx in
            let p = try ctx.decode(PresenceConfirmParams.self)
            guard PresenceMessage.isValidChallenge(p.challenge) else {
                throw CapabilityError.invalidParams("challenge must be 64 hex characters", field: "challenge")
            }
            guard !p.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw CapabilityError.invalidParams("summary must not be empty", field: "summary")
            }
            guard isValidCode(p.code) else {
                throw CapabilityError.invalidParams("code must be xxxx-xxxx hex", field: "code")
            }
            let signed = try await key.sign(challenge: p.challenge, reason: confirmReason(summary: p.summary, code: p.code))
            return CapabilityOutput(["signature": .string(signed.signature), "keyId": .string(signed.keyId)])
        }
    }

    static func publicKey(_ key: any PresenceSigning) -> Capability {
        Capability(CapabilitySpec(
            name: "presence.public_key",
            description: "The helper's Secure Enclave presence public key (P-256, X9.63 uncompressed, base64url), keyId (hex SHA-256 of it) and kind "
                + "(keychain, or enclave_file on builds without a keychain access group). Created on first use; never prompts.",
            sideEffect: .read
        )) { _ in
            let (x963, keyId) = try key.publicKey()
            return CapabilityOutput([
                "publicKey": .string(Base64URL.encode(x963)), "keyId": .string(keyId), "kind": .string(key.keyKind.rawValue),
            ])
        }
    }
}
