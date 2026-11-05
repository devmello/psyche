import CryptoKit
import Foundation
import PsycheHelperCore
import PsycheProtocol
import PsycheWire
import Security

// The Secure Enclave presence key for builds with no provisioning profile (a self-signed release,
// say), kept in the login (file-based) keychain behind an access list that trusts only this
// helper's designated requirement. It needs no entitlement and no keychain access group.
//
// Everything in this file uses the legacy file-based keychain API (`SecAccess`, `SecACL`,
// `SecTrustedApplication`, `SecKeychainItemCopyAccess`, `kSecUseKeychain`). Apple marks it
// deprecated, but it is the only keychain with per-program access lists, and it was checked to work
// on macOS 27 (security §10). `kSecUseDataProtectionKeychain` must be false: the data-protection
// keychain has no access lists and needs the access-group entitlement.

/// What the key needs from the login keychain. Live: `LoginKeychainAclStore`. Tests use a memory
/// store, or the live one against a temporary keychain.
public protocol AclKeychainStore: Sendable {
    /// The stored envelope, nil when there is none.
    func loadPayload() throws -> Data?
    /// Stores `payload` (creating the item with a helper-only access list when it is new).
    func storePayload(_ payload: Data) throws
    /// ECDSA signature by the seal key (an access-list-protected software key; created if missing).
    func seal(_ message: Data) throws -> Data
    /// Whether `signature` is the seal key's over `message`. False when there is no seal key.
    func verifySeal(_ message: Data, signature: Data) throws -> Bool
    /// True when every item this store holds is the helper's own: access lists that name only this
    /// helper (designated requirement), for the key item and the seal key.
    func isTrusted() throws -> Bool
    /// Deletes both items. May make macOS ask the owner when another program made them.
    func wipe() throws
}

extension PresenceKeyErrors {
    /// An item with our name that this helper did not make (or whose contents changed): never used.
    public static func untrusted(_ what: String) -> CapabilityError {
        CapabilityError(
            .errorCodeInternal, reason: "presence_key_untrusted",
            "The Touch ID key in the keychain was not made by Psyche Helper (\(what)). Remove it and set up Touch ID again in Settings → Devices."
        )
    }

    /// macOS asked the owner whether this helper may use the keychain item and they said no.
    public static let accessDenied = CapabilityError(
        .forbidden, reason: "presence_key_access_denied",
        "macOS did not let Psyche Helper use its Touch ID key in the keychain. Choose Always Allow when it asks, then try again."
    )
}

/// The key: a CryptoKit Secure Enclave key (same access control as `PresenceKey`) whose wrapped blob
/// lives in a login-keychain item readable only by this helper, sealed by a keychain key only this
/// helper can sign with.
///
/// Envelope: `PSYPK2`, u16 signature length, signature, u16 state length, enrollment state, blob.
/// The signature is the seal key's over `PSYPK2`, the state and the blob. Reading the item needs the
/// access list's say-so (another program gets a macOS prompt naming it); writing it does not, so
/// the seal is what makes a replaced item useless: nobody else can sign. An item whose access list
/// names anything but this helper, or whose seal does not verify, is never adopted (security §10).
public final class EnclaveKeychainAclPresenceKey: PresenceSigning, @unchecked Sendable {
    private let backend: any EnclaveKeyBackend
    private let store: any AclKeychainStore
    private let biometry: any BiometryStateSource
    private let onCreated: @Sendable () -> Void
    private let lock = NSLock()
    private var pinned: Data?

    static let magic = Data("PSYPK2".utf8)

    public var keyKind: PresenceKeyKind { .enclaveKeychainAcl }

    public init(
        store: any AclKeychainStore = LoginKeychainAclStore(), backend: any EnclaveKeyBackend = SecureEnclaveBackend(),
        biometry: any BiometryStateSource = LiveBiometryState(),
        onCreated: @escaping @Sendable () -> Void = EnclaveKeychainAclPresenceKey.retireLegacyFileKey
    ) {
        self.store = store
        self.backend = backend
        self.biometry = biometry
        self.onCreated = onCreated
    }

    struct Envelope: Equatable {
        var state: Data
        var blob: Data
    }

    static func message(_ e: Envelope) -> Data {
        var m = magic
        m.append(UInt8(e.state.count >> 8))
        m.append(UInt8(e.state.count & 0xFF))
        m.append(e.state)
        m.append(e.blob)
        return m
    }

    func encode(_ e: Envelope) throws -> Data {
        let sig = try store.seal(Self.message(e))
        guard sig.count < 1024 else { throw PresenceKeyErrors.untrusted("seal too large") }
        var d = Self.magic
        d.append(UInt8(sig.count >> 8))
        d.append(UInt8(sig.count & 0xFF))
        d.append(sig)
        d.append(UInt8(e.state.count >> 8))
        d.append(UInt8(e.state.count & 0xFF))
        d.append(e.state)
        d.append(e.blob)
        return d
    }

    /// The verified envelope, nil when there is no item. Throws `presence_key_untrusted` for one that
    /// is not ours (foreign access list, missing or wrong seal, malformed).
    func load() throws -> Envelope? {
        // The access lists first: an item that an open or foreign list guards is not read at all.
        guard try store.isTrusted() else { throw PresenceKeyErrors.untrusted("its access list names another program") }
        guard let data = try store.loadPayload() else { return nil }
        let bad = PresenceKeyErrors.untrusted("it is not sealed by this helper")
        var i = Self.magic.count
        guard data.count > i + 2, data.prefix(i) == Self.magic else { throw bad }
        let sigLen = Int(data[i]) << 8 | Int(data[i + 1])
        i += 2
        guard sigLen > 0, data.count > i + sigLen + 2 else { throw bad }
        let sig = data.subdata(in: i..<(i + sigLen))
        i += sigLen
        let stateLen = Int(data[i]) << 8 | Int(data[i + 1])
        i += 2
        guard data.count > i + stateLen else { throw bad }
        let env = Envelope(state: data.subdata(in: i..<(i + stateLen)), blob: data.subdata(in: (i + stateLen)..<data.count))
        guard try store.verifySeal(Self.message(env), signature: sig) else { throw bad }
        return env
    }

    private func failure(_ reason: String, _ what: String) -> CapabilityError {
        CapabilityError(.errorCodeInternal, reason: reason, "Touch ID key in the keychain: \(what)")
    }

    /// The verified key (made on first use), pinned for this process.
    func current() throws -> (env: Envelope, x963: Data) {
        try lock.withLock {
            var loaded: Envelope?
            do {
                loaded = try load()
            } catch let e as CapabilityError where e.reason == "presence_key_untrusted" && pinned == nil {
                // Not this helper's: never adopt it. Remove it (macOS may ask the owner) and make our
                // own; the owner registers the new key again, as for any new key.
                try store.wipe()
                loaded = nil
            }
            if let loaded {
                let x963 = try backend.publicKey(blob: loaded.blob)
                if let pinned, pinned != x963 {
                    throw failure("presence_key_changed", "changed while the helper was running; restart Psyche Helper")
                }
                pinned = x963
                return (loaded, x963)
            }
            if pinned != nil {
                throw failure("presence_key_changed", "disappeared while the helper was running; restart Psyche Helper")
            }
            // A new key: start from nothing, so no stray item of ours with another list survives.
            try store.wipe()
            let made = Envelope(state: biometry.current() ?? Data(), blob: try backend.create())
            try store.storePayload(try encode(made))
            guard let onDisk = try load() else { throw failure("presence_key_file", "could not be read back") }
            let x963 = try backend.publicKey(blob: onDisk.blob)
            pinned = x963
            onCreated()
            return (onDisk, x963)
        }
    }

    public func publicKey() throws -> (x963: Data, keyId: String) {
        let x963 = try current().x963
        return (x963, PresenceMessage.keyId(x963: x963))
    }

    public func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        guard PresenceMessage.isValidChallenge(challenge) else {
            throw CapabilityError.invalidParams("presenceChallenge must be 64 hex characters", field: "presenceChallenge")
        }
        let (env, x963) = try current()
        // A changed enrollment hash is only a hint (an OS update can change it): still try to sign.
        let now = biometry.current()
        let changed = !env.state.isEmpty && now != nil && now != env.state
        let der: Data
        do {
            der = try await backend.sign(blob: env.blob, message: PresenceMessage.bytes(challenge: challenge), reason: reason)
        } catch let e as CapabilityError where e.reason == PresenceKeyErrors.refused.reason {
            retire()
            throw PresenceKeyErrors.invalidated(enrollmentChanged: changed)
        }
        if changed, let now { try? rerecord(Envelope(state: now, blob: env.blob)) }
        return PresenceSignature(signature: Base64URL.encode(der), keyId: PresenceMessage.keyId(x963: x963))
    }

    /// The key still signs under a new enrollment state: seal that state with it.
    func rerecord(_ env: Envelope) throws {
        try lock.withLock { try store.storePayload(try encode(env)) }
    }

    /// A refused key is removed; the next use makes (and pins) a new one.
    func retire() {
        lock.withLock {
            try? store.wipe()
            pinned = nil
        }
    }

    /// Migration from the development file key: it was readable by any same-user process, so it is
    /// not carried over (a new key means registering again). Called when a key is first made.
    @Sendable public static func retireLegacyFileKey() {
        let path = EnclaveFilePresenceKey.defaultPath()
        unlink(path)
        unlink(path + ".rejected")
        LoginKeychainSealer().removeSecret()
    }
}

/// The live store: a generic-password item (the envelope) and a software P-256 key (the seal) in
/// the login keychain, or in `keychainPath` for tests. Both get an access list naming only the
/// running program, which the keychain matches by designated requirement (not path or cdhash) when
/// the program is signed with a certificate, so an update signed with the same certificate keeps
/// access silently. Anyone else who reads or signs gets a macOS prompt that names them.
public struct LoginKeychainAclStore: AclKeychainStore {
    static let service = "com.psyche.helper.presence-key"
    static let account = "se-blob-v2"
    static let sealLabel = "Psyche Helper Touch ID key seal (v2)"

    /// nil: the default (login) keychain.
    public var keychainPath: String?
    /// Tests: never let macOS show a prompt; a program the list does not trust gets an error.
    public var interactionAllowed: Bool

    public init(keychainPath: String? = nil, interactionAllowed: Bool = true) {
        self.keychainPath = keychainPath
        self.interactionAllowed = interactionAllowed
    }

    private func keychain() throws -> SecKeychain? {
        if !interactionAllowed { SecKeychainSetUserInteractionAllowed(false) }
        guard let keychainPath else { return nil }
        var kc: SecKeychain?
        let status = SecKeychainOpen(keychainPath, &kc)
        guard status == errSecSuccess, let kc else { throw KeychainStatus.error(from: KeychainOSStatusError(status)) }
        return kc
    }

    private func itemQuery(_ kc: SecKeychain?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecUseDataProtectionKeychain as String: false,
        ]
        if let kc { q[kSecMatchSearchList as String] = [kc] }
        return q
    }

    private func sealQuery(_ kc: SecKeychain?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrLabel as String: Self.sealLabel,
            kSecUseDataProtectionKeychain as String: false,
        ]
        if let kc { q[kSecMatchSearchList as String] = [kc] }
        return q
    }

    static func mapped(_ status: OSStatus) -> Error {
        if status == errSecAuthFailed || status == errSecInteractionNotAllowed || status == errSecUserCanceled
            || status == errSecNotAvailable
        {
            return PresenceKeyErrors.accessDenied
        }
        return KeychainStatus.error(from: KeychainOSStatusError(status))
    }

    /// An access list naming only this program for everything but changing the list itself, which
    /// stays with macOS (an empty list: every change asks the owner).
    static func ownAccess(label: String) throws -> SecAccess {
        var app: SecTrustedApplication?
        var status = SecTrustedApplicationCreateFromPath(nil, &app)
        guard status == errSecSuccess, let app else { throw KeychainStatus.error(from: KeychainOSStatusError(status)) }
        var access: SecAccess?
        status = SecAccessCreate(label as CFString, [app] as CFArray, &access)
        guard status == errSecSuccess, let access else { throw KeychainStatus.error(from: KeychainOSStatusError(status)) }
        var list: CFArray?
        SecAccessCopyACLList(access, &list)
        for acl in (list as? [SecACL]) ?? [] {
            let auths = (SecACLCopyAuthorizations(acl) as? [String]) ?? []
            if auths.contains(kSecACLAuthorizationChangeACL as String) { continue }
            var apps: CFArray?
            var desc: CFString?
            var sel = SecKeychainPromptSelector()
            SecACLCopyContents(acl, &apps, &desc, &sel)
            SecACLSetContents(acl, [app] as CFArray, (desc ?? label as CFString), sel)
        }
        return access
    }

    public func loadPayload() throws -> Data? {
        let kc = try keychain()
        var q = itemQuery(kc)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw Self.mapped(status) }
        return data
    }

    public func storePayload(_ payload: Data) throws {
        let kc = try keychain()
        let status = SecItemUpdate(itemQuery(kc) as CFDictionary, [kSecValueData as String: payload] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw Self.mapped(status) }
        var add = itemQuery(kc)
        add.removeValue(forKey: kSecMatchSearchList as String)
        if let kc { add[kSecUseKeychain as String] = kc }
        add[kSecValueData as String] = payload
        add[kSecAttrLabel as String] = "Psyche Helper Touch ID key"
        add[kSecAttrAccess as String] = try Self.ownAccess(label: "Psyche Helper Touch ID key")
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw Self.mapped(added) }
    }

    private func sealKey(_ kc: SecKeychain?, create: Bool) throws -> SecKey? {
        var q = sealQuery(kc)
        q[kSecReturnRef as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecSuccess, let out { return (out as! SecKey) }  // swiftlint:disable:this force_cast
        guard status == errSecItemNotFound else { throw Self.mapped(status) }
        guard create else { return nil }
        var attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrIsPermanent as String: true,
            kSecAttrLabel as String: Self.sealLabel,
            kSecAttrAccess as String: try Self.ownAccess(label: Self.sealLabel),
        ]
        if let kc { attrs[kSecUseKeychain as String] = kc }
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else { throw PresenceKey.failure(error?.takeRetainedValue()) }
        return key
    }

    public func seal(_ message: Data) throws -> Data {
        guard let key = try sealKey(try keychain(), create: true) else { throw PresenceKey.failure(nil) }
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
            let code = error.map { CFErrorGetCode($0.takeUnretainedValue()) } ?? 0
            throw Self.mapped(OSStatus(code))
        }
        return sig
    }

    public func verifySeal(_ message: Data, signature: Data) throws -> Bool {
        guard let key = try sealKey(try keychain(), create: false), let pub = SecKeyCopyPublicKey(key) else { return false }
        var error: Unmanaged<CFError>?
        let ok = SecKeyVerifySignature(pub, .ecdsaSignatureMessageX962SHA256, message as CFData, signature as CFData, &error)
        error?.release()
        return ok
    }

    public func isTrusted() throws -> Bool {
        let kc = try keychain()
        var q = itemQuery(kc)
        q[kSecReturnRef as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &item)
        if st == errSecItemNotFound { return true }
        guard st == errSecSuccess, let item else { throw Self.mapped(st) }
        // An item without our seal key can never verify; a seal key we did not make is as bad.
        guard let seal = try sealKey(kc, create: false) else { return false }
        return AclAudit.namesOnlyThisProgram(item) && AclAudit.namesOnlyThisProgram(seal)
    }

    public func wipe() throws {
        let kc = try keychain()
        for q in [itemQuery(kc), sealQuery(kc)] {
            let status = SecItemDelete(q as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.mapped(status) }
        }
    }
}

/// Reads an item's access list (`SecKeychainItemCopyAccess` family, deprecated) and answers whether
/// every entry that matters trusts only this program.
enum AclAudit {
    /// This program's designated requirement; nil for an unsigned or ad-hoc build we cannot ask.
    static func ownRequirement() -> SecRequirement? {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode else { return nil }
        var req: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(staticCode, SecCSFlags(), &req) == errSecSuccess else { return nil }
        return req
    }

    static func ownPath() -> String? {
        var size: UInt32 = 0
        _NSGetExecutablePath(nil, &size)
        var buf = [CChar](repeating: 0, count: Int(size))
        guard _NSGetExecutablePath(&buf, &size) == 0 else { return nil }
        return URL(fileURLWithPath: String(cString: buf)).resolvingSymlinksInPath().path
    }

    /// A trusted-application entry is this program: its path is ours, or the code at that path
    /// satisfies our designated requirement (so a moved or updated copy signed by us still counts).
    static func isThisProgram(_ app: SecTrustedApplication, path: String? = ownPath(), requirement: SecRequirement? = ownRequirement()) -> Bool {
        var data: CFData?
        guard SecTrustedApplicationCopyData(app, &data) == errSecSuccess, let data = data as Data? else { return false }
        let raw = data.prefix { $0 != 0 }
        guard let entry = String(data: raw, encoding: .utf8), entry.hasPrefix("/") else { return false }
        if let path, URL(fileURLWithPath: entry).resolvingSymlinksInPath().path == path { return true }
        guard let requirement else { return false }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: entry) as CFURL, SecCSFlags(), &code) == errSecSuccess, let code else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
    }

    /// Every access-list entry other than "encrypt" (writing is never guarded) lists applications,
    /// none of them anyone but this program. The entry that changes the list may be empty (macOS
    /// asks the owner), but never open (nil) and never someone else.
    static func namesOnlyThisProgram(_ ref: CFTypeRef) -> Bool {
        let path = ownPath()
        let req = ownRequirement()
        var access: SecAccess?
        guard SecKeychainItemCopyAccess(unsafeBitCast(ref, to: SecKeychainItem.self), &access) == errSecSuccess, let access else { return false }
        var list: CFArray?
        guard SecAccessCopyACLList(access, &list) == errSecSuccess, let acls = list as? [SecACL] else { return false }
        var sawRead = false
        for acl in acls {
            let auths = (SecACLCopyAuthorizations(acl) as? [String]) ?? []
            if auths == [kSecACLAuthorizationEncrypt as String] { continue }
            var apps: CFArray?
            var desc: CFString?
            var sel = SecKeychainPromptSelector()
            guard SecACLCopyContents(acl, &apps, &desc, &sel) == errSecSuccess, let trusted = apps as? [SecTrustedApplication] else {
                return false  // nil: any program
            }
            let isChange = auths.contains(kSecACLAuthorizationChangeACL as String)
            if !isChange {
                guard !trusted.isEmpty else { return false }
                sawRead = true
            }
            if !trusted.allSatisfy({ isThisProgram($0, path: path, requirement: req) }) { return false }
        }
        return sawRead
    }
}
