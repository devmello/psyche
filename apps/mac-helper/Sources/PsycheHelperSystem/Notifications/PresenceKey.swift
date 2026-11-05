import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheProtocol
import PsycheWire
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
    /// Like `publicKey()` but read only: nil when no key exists yet, and never creates, deletes or
    /// rewrites anything (`psyche-helper --print-identity`).
    func existingPublicKey() throws -> (x963: Data, keyId: String)?
}

extension PresenceSigning {
    public func existingPublicKey() throws -> (x963: Data, keyId: String)? { try publicKey() }
}

/// The Mac's Touch ID enrollment as an opaque hash (`LAContext.domainState.biometry.stateHash`):
/// it changes when a fingerprint is added or removed, which is what makes a `.biometryCurrentSet`
/// key unusable, but it may also change without one (an OS update). So it is only a hint: recorded
/// when a key is created, compared before each signature, and on a change the helper still tries
/// to sign. Only when the Secure Enclave then refuses the key is it moved aside (never deleted) and
/// reported as `presence_key_invalidated`; a key that still signs gets the new state recorded.
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
    /// Touch ID passed but the Secure Enclave refused the key (the fingerprints changed since it
    /// was made). The helper has moved it aside, never deleted it; the next `presence.public_key`
    /// makes a new one, which the owner registers again (security §10, recovery).
    public static func invalidated(enrollmentChanged: Bool) -> CapabilityError {
        CapabilityError(
            .unavailable, reason: "presence_key_invalidated",
            enrollmentChanged
                ? "Touch ID changed since this key was set up, so it can no longer sign. Set up Touch ID again in Settings → Devices."
                : "The Secure Enclave refused this Touch ID key. Set up Touch ID again in Settings → Devices.",
            details: ["enrollmentChanged": .bool(enrollmentChanged)]
        )
    }

    /// What a key backend throws when the Secure Enclave refuses a key after Touch ID passed.
    public static let refused = CapabilityError(.unavailable, reason: "presence_key_refused", "The Secure Enclave refused the Touch ID key")
}

/// The helper's presence key: one Secure Enclave P-256 key in the data-protection keychain
/// (`kSecAttrTokenIDSecureEnclave`, permanent, this device only, non-synchronizable), access control
/// `[.privateKeyUsage, .biometryCurrentSet]`, so every signature needs a current fingerprint.
/// Like every data-protection keychain item it needs the keychain access group entitlement
/// (provisioning profile); without it the key cannot be created (`missing_entitlement`) and the
/// helper uses `EnclaveKeychainAclPresenceKey` instead (`PreferredPresenceKey`).
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

    /// Lookup only: nil when the keychain holds none (a build with no access group throws
    /// `missing_entitlement` here, which is how `PreferredPresenceKey` moves on).
    public func existingPublicKey() throws -> (x963: Data, keyId: String)? {
        if !secureEnclave { return try publicKey() }
        var ref: CFTypeRef?
        let status = SecItemCopyMatching(lookupQuery(context: nil) as CFDictionary, &ref)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let ref, let pub = SecKeyCopyPublicKey(ref as! SecKey) else {  // swiftlint:disable:this force_cast
            throw KeychainStatus.error(from: KeychainOSStatusError(status))
        }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(pub, &error) as Data? else { throw Self.failure(error?.takeRetainedValue()) }
        return (data, PresenceMessage.keyId(x963: data))
    }

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

    private var itemQuery: [String: Any] {
        var q = lookupQuery(context: nil)
        q.removeValue(forKey: kSecReturnRef as String)
        return q
    }

    /// A key that still signs under a new enrollment state: record that state.
    func rerecord(_ state: Data) {
        if !secureEnclave { return lock.withLock { ephemeralState = state } }
        SecItemUpdate(itemQuery as CFDictionary, [kSecAttrLabel as String: Self.labelPrefix + Base64URL.encode(state)] as CFDictionary)
    }

    /// Moves a refused key aside under another tag (kept, never deleted), so the next use makes a
    /// new one and the old one can still be inspected or restored.
    func retire() {
        if !secureEnclave {
            lock.withLock {
                ephemeral = nil
                ephemeralState = nil
            }
            return
        }
        let retiredTag = Data("com.psyche.helper.presence.retired.\(Int(Date().timeIntervalSince1970))".utf8)
        SecItemUpdate(itemQuery as CFDictionary, [kSecAttrApplicationTag as String: retiredTag] as CFDictionary)
    }

    public func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        guard PresenceMessage.isValidChallenge(challenge) else {
            throw CapabilityError.invalidParams("presenceChallenge must be 64 hex characters", field: "presenceChallenge")
        }
        // A changed enrollment hash is only a hint (an OS update can change it): still try to sign.
        _ = try privateKey()
        let now = biometry.current()
        let recorded = recordedState()
        let changed = recorded != nil && now != nil && recorded != now
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
            // Touch ID passed and the Secure Enclave still refused the key: it is dead.
            if secureEnclave {
                retire()
                throw PresenceKeyErrors.invalidated(enrollmentChanged: changed)
            }
            throw Self.failure(error?.takeRetainedValue())
        }
        if changed, let now { rerecord(now) }
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
        // The code first: it is what the owner compares with the card, and a long summary is cut.
        return "approve code \(code): \u{201C}\(NotificationLimits.truncate(oneLine, max: maxSummary))\u{201D} in Psyche"
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
            ),
            receiptKind: "approval_presence"
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
            return CapabilityOutput(
                ["signature": .string(signed.signature), "keyId": .string(signed.keyId)],
                receipt: ReceiptDraft(
                    outcome: .ok, summary: "Confirmed an approval with Touch ID",
                    externalRefs: ["approvalCode": .string(p.code), "keyId": .string(signed.keyId)]
                )
            )
        }
    }

    static func publicKey(_ key: any PresenceSigning) -> Capability {
        Capability(CapabilitySpec(
            name: "presence.public_key",
            description: "The helper's Secure Enclave presence public key (P-256, X9.63 uncompressed, base64url), keyId (hex SHA-256 of it) and kind "
                + "(keychain; enclave_keychain_acl on builds without a keychain access group; enclave_file in development builds only). Created on first use by the running helper (`--print-identity` only reads); never shows Touch ID, but macOS may ask the owner whether this helper may use its keychain item after the signing certificate changed.",
            sideEffect: .read
        )) { _ in
            let (x963, keyId) = try key.publicKey()
            return CapabilityOutput([
                "publicKey": .string(Base64URL.encode(x963)), "keyId": .string(keyId), "kind": .string(key.keyKind.rawValue),
            ])
        }
    }
}
