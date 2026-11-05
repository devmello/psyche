import CryptoKit
import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheProtocol
import PsycheWire
import Security

// The Secure Enclave presence key for builds with no provisioning profile (a self-signed release,
// say), kept in the login (file-based) keychain behind an access list that trusts only this
// helper. It needs no entitlement and no keychain access group.
//
// Everything in this file uses the legacy file-based keychain API (`SecAccess`, `SecACL`,
// `SecTrustedApplication`, `SecKeychainItemCopyAccess`, `kSecUseKeychain`). Apple marks it
// deprecated, but it is the only keychain with per-program access lists, and it was checked to work
// on macOS 27 (security §10). `kSecUseDataProtectionKeychain` must be false: the data-protection
// keychain has no access lists and needs the access-group entitlement.
//
// What an access list is: who may USE an item, not who CREATED it. A same-user program can add its
// own item (and its own seal key) with a list that names this helper, so the checks below only
// narrow the attack (security §10 lists what is left): one pinned keychain, exactly one item and one
// seal key, the same refs audited, read and verified, a key that must need Touch ID, and no silent
// repair.

/// What `AclKeychainStore.read` found, from one pass over one set of item refs.
public enum AclStoreRead {
    /// Nothing of ours is stored.
    case absent
    /// One item and one seal key, both with helper-only access lists. `verify(message, signature)` is
    /// the seal key's public check, made on the same key ref that was audited.
    case trusted(payload: Data, verify: @Sendable (Data, Data) -> Bool)
    /// Something is stored but cannot be vouched for (foreign or open access list, a duplicate, a
    /// missing seal key, an unreadable keychain). Never used, never deleted by the helper itself.
    case untrusted(String)
}

/// What the key needs from the login keychain. Live: `LoginKeychainAclStore`. Tests use a memory
/// store, or the live one against a temporary keychain.
public protocol AclKeychainStore: Sendable {
    /// Audits and reads in one pass. Never creates, changes or deletes anything.
    func read() throws -> AclStoreRead
    /// Makes the seal key and the item. Refuses (`presence_key_untrusted`) when anything of ours is
    /// already there: a pre-existing seal key is never reused, because whoever made it can seal.
    /// `build` receives the seal function and returns the payload to store.
    func create(_ build: (_ seal: (Data) throws -> Data) throws -> Data) throws
    /// Replaces the payload of a trusted item (sealed with the audited seal key).
    func rewrite(_ build: (_ seal: (Data) throws -> Data) throws -> Data) throws
    /// Deletes the item and the seal key: an owner action (macOS may ask when another program made
    /// them), or the cleanup after the Secure Enclave refused our own key.
    func reset() throws
}

extension PresenceKeyErrors {
    /// Something with our name that this helper cannot vouch for. Never used; the owner resets it.
    public static func untrusted(_ what: String) -> CapabilityError {
        CapabilityError(
            .errorCodeInternal, reason: "presence_key_untrusted",
            "The Touch ID key in the keychain was not used because it cannot be shown to be Psyche Helper's (\(what)). Reset it with the helper's --reset-presence-key option, then register the new key."
        )
    }

    /// macOS asked the owner whether this helper may use the keychain item and they said no.
    public static let accessDenied = CapabilityError(
        .forbidden, reason: "presence_key_access_denied",
        "macOS did not let Psyche Helper use its Touch ID key in the keychain. Choose Always Allow when it asks, then try again."
    )

    /// The keychain access-list API did not behave: stop, do not retry in this process.
    public static let aclUnavailable = CapabilityError(
        .unavailable, reason: "presence_key_acl_unavailable",
        "The keychain would not keep an access list for the Touch ID key on this Mac. Nothing was changed further; restart Psyche Helper to try again."
    )
}

/// The key: a CryptoKit Secure Enclave key (same access control as `PresenceKey`) whose wrapped blob
/// lives in a login-keychain item readable only by this helper, sealed by a keychain key only this
/// helper can sign with.
///
/// Envelope: `PSYPK2`, u16 signature length, signature, u16 state length, enrollment state, blob.
/// The signature is the seal key's over `PSYPK2`, the state and the blob. Reading the item needs the
/// access list's say-so (another program gets a macOS prompt naming it); writing it does not, so
/// the seal is what makes a replaced value useless to someone who cannot sign.
///
/// Fail closed (security §10): anything that cannot be vouched for is refused with
/// `presence_key_untrusted` and left alone; the helper never deletes it and makes a new key on its
/// own. Only `resetByOwner()` (`psyche-helper --reset-presence-key`) replaces it.
public final class EnclaveKeychainAclPresenceKey: PresenceSigning, @unchecked Sendable {
    private let backend: any EnclaveKeyBackend
    private let store: any AclKeychainStore
    private let biometry: any BiometryStateSource
    private let lockPath: String
    private let lock = NSLock()
    private var pinned: Data?
    private var probed = false
    private var creationFailure: CapabilityError?

    static let magic = Data("PSYPK2".utf8)

    public var keyKind: PresenceKeyKind { .enclaveKeychainAcl }

    public init(
        store: any AclKeychainStore = LoginKeychainAclStore(), backend: any EnclaveKeyBackend = SecureEnclaveBackend(),
        biometry: any BiometryStateSource = LiveBiometryState(),
        lockPath: String = EnclaveKeychainAclPresenceKey.defaultLockPath()
    ) {
        self.store = store
        self.backend = backend
        self.biometry = biometry
        self.lockPath = lockPath
    }

    /// Records that a key has existed (its key id), next to the creation lock. A slot that is empty
    /// while the marker exists is not a first run: the helper reports `presence_key_untrusted` and the
    /// owner resets, instead of making a key in whatever keychain it now finds. A same-user program
    /// can delete the marker too, so this stops the accidental and automatic case, not malware.
    private var markerPath: String { (lockPath as NSString).deletingLastPathComponent + "/key-marker" }

    var markerExists: Bool {
        var st = stat()
        return lstat(markerPath, &st) == 0
    }

    private func writeMarker(_ x963: Data) {
        let dir = (markerPath as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        FileManager.default.createFile(
            atPath: markerPath, contents: Data(PresenceMessage.keyId(x963: x963).utf8), attributes: [.posixPermissions: 0o600]
        )
    }

    private func removeMarker() { unlink(markerPath) }

    private func gone() -> CapabilityError {
        PresenceKeyErrors.untrusted("a Touch ID key was made here before and is gone, so this is not a first run")
    }

    public static func defaultLockPath() -> String {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Psyche Helper/presence/create.lock").path
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

    func encode(_ e: Envelope, seal: (Data) throws -> Data) throws -> Data {
        let sig = try seal(Self.message(e))
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

    /// Parses and verifies an envelope with the audited seal key's check.
    static func openEnvelope(_ data: Data, verify: (Data, Data) -> Bool) -> Envelope? {
        var i = magic.count
        guard data.count > i + 2, data.prefix(i) == magic else { return nil }
        let sigLen = Int(data[i]) << 8 | Int(data[i + 1])
        i += 2
        guard sigLen > 0, data.count > i + sigLen + 2 else { return nil }
        let sig = data.subdata(in: i..<(i + sigLen))
        i += sigLen
        let stateLen = Int(data[i]) << 8 | Int(data[i + 1])
        i += 2
        guard data.count > i + stateLen else { return nil }
        let env = Envelope(state: data.subdata(in: i..<(i + stateLen)), blob: data.subdata(in: (i + stateLen)..<data.count))
        return verify(message(env), sig) ? env : nil
    }

    private func failure(_ reason: String, _ what: String) -> CapabilityError {
        CapabilityError(.errorCodeInternal, reason: reason, "Touch ID key in the keychain: \(what)")
    }

    /// Adopts a stored key or throws; caller holds `lock`. Checks, in order: the seal verifies, and
    /// the key refuses to sign without Touch ID (a planted key made without biometry is refused).
    private func adopt(payload: Data, verify: @Sendable (Data, Data) -> Bool) throws -> (env: Envelope, x963: Data) {
        guard let env = Self.openEnvelope(payload, verify: verify) else { throw PresenceKeyErrors.untrusted("it is not sealed by this helper") }
        if !probed {
            // Never shows UI: the probe's context forbids interaction. A key that signs anyway needs
            // no fingerprint and is not ours.
            if backend.signsWithoutAuthentication(blob: env.blob) { throw PresenceKeyErrors.untrusted("the key does not require Touch ID") }
            probed = true
        }
        let x963: Data
        do {
            x963 = try backend.publicKey(blob: env.blob)
        } catch {
            throw PresenceKeyErrors.untrusted("the stored key cannot be used")
        }
        if let pinned, pinned != x963 {
            throw failure("presence_key_changed", "changed while the helper was running; restart Psyche Helper")
        }
        pinned = x963
        return (env, x963)
    }

    /// The verified key. `create: false` never writes (`--print-identity`): nil when none exists.
    func current(create: Bool = true) throws -> (env: Envelope, x963: Data)? {
        try lock.withLock {
            if let creationFailure { throw creationFailure }
            switch try store.read() {
            case .untrusted(let why):
                throw PresenceKeyErrors.untrusted(why)
            case .trusted(let payload, let verify):
                let adopted = try adopt(payload: payload, verify: verify)
                if create, !markerExists { writeMarker(adopted.x963) }
                return adopted
            case .absent:
                if pinned != nil {
                    throw failure("presence_key_changed", "disappeared while the helper was running; restart Psyche Helper")
                }
                if markerExists { throw gone() }
                guard create else { return nil }
                return try createLocked()
            }
        }
    }

    /// Makes the first key, under a cross-process lock so two helper processes (or a helper and
    /// `--reset-presence-key`) cannot both create. Caller holds `lock`.
    private func createLocked() throws -> (env: Envelope, x963: Data) {
        try withCreationLock {
            // Another process may have made it while we waited.
            switch try store.read() {
            case .untrusted(let why): throw PresenceKeyErrors.untrusted(why)
            case .trusted(let payload, let verify): return try adopt(payload: payload, verify: verify)
            case .absent: break
            }
            if markerExists { throw gone() }
            let made = Envelope(state: biometry.current() ?? Data(), blob: try backend.create())
            try store.create { seal in try encode(made, seal: seal) }
            // The read-back must pass our own audit. If it does not, the ACL API is not doing what we
            // rely on: stop, and do not retry or churn in this process.
            guard case .trusted(let payload, let verify) = try store.read() else {
                creationFailure = PresenceKeyErrors.aclUnavailable
                throw PresenceKeyErrors.aclUnavailable
            }
            let adopted = try adopt(payload: payload, verify: verify)
            writeMarker(adopted.x963)
            return adopted
        }
    }

    private func withCreationLock<T>(_ body: () throws -> T) throws -> T {
        let dir = (lockPath as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            throw failure("presence_key_file", "its folder could not be created")
        }
        let fd = open(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw failure("presence_key_file", "its lock could not be opened") }
        defer { close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw failure("presence_key_file", "its lock could not be taken") }
        defer { flock(fd, LOCK_UN) }
        return try body()
    }

    /// Creates the key if missing: what the running helper and `presence.public_key` do.
    public func publicKey() throws -> (x963: Data, keyId: String) {
        guard let x963 = try current(create: true)?.x963 else { throw failure("no_presence_key", "no key") }
        return (x963, PresenceMessage.keyId(x963: x963))
    }

    /// Read only (`--print-identity`): never creates, deletes or rewrites; nil when there is no key.
    public func existingPublicKey() throws -> (x963: Data, keyId: String)? {
        guard let x963 = try current(create: false)?.x963 else { return nil }
        return (x963, PresenceMessage.keyId(x963: x963))
    }

    public func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        guard PresenceMessage.isValidChallenge(challenge) else {
            throw CapabilityError.invalidParams("presenceChallenge must be 64 hex characters", field: "presenceChallenge")
        }
        guard let (env, x963) = try current(create: true) else { throw failure("no_presence_key", "no key") }
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
        try lock.withLock { try store.rewrite { seal in try encode(env, seal: seal) } }
    }

    /// Our own key, which the Secure Enclave refused (fingerprints changed): removed, so the owner
    /// can set up Touch ID again. Only reached for an item that was just verified as ours.
    func retire() {
        lock.withLock {
            try? store.reset()
            removeMarker()  // our own verified key died: the next use is a fresh start
            pinned = nil
            probed = false
        }
    }

    /// The owner's reset (`psyche-helper --reset-presence-key`): deletes whatever is stored (macOS
    /// may ask when another program made it) and makes a new key. The new key has a new key id: the
    /// owner registers it again in Settings → Devices.
    public func resetByOwner() throws -> (x963: Data, keyId: String) {
        try lock.withLock {
            creationFailure = nil
            try withCreationLock {
                try store.reset()
                removeMarker()
            }
            pinned = nil
            probed = false
            let made = try createLocked()  // the real error, not a generic one
            return (made.x963, PresenceMessage.keyId(x963: made.x963))
        }
    }

    /// Migration from the development file key. It was readable by any same-user process, so it is
    /// not carried over. The helper cannot learn that the Gateway registered the new key, so it never
    /// removes the old file on its own: the owner runs `psyche-helper --retire-legacy-presence-key`
    /// (or deletes the file) once the new key is registered and Settings → Devices no longer lists
    /// the old one.
    public static func retireLegacyFileKey() {
        let path = EnclaveFilePresenceKey.defaultPath()
        unlink(path)
        unlink(path + ".rejected")
        LoginKeychainSealer().removeSecret()
    }
}

/// The live store: a generic-password item (the envelope) and a software P-256 key (the seal) in
/// the login keychain, or in `keychainPath` for tests. Both get an access list naming only the
/// running program. The keychain is pinned explicitly (never "the default" or the search list),
/// and exactly one item and one seal key may exist.
public struct LoginKeychainAclStore: AclKeychainStore {
    static let service = "com.psyche.helper.presence-key"
    static let account = "se-blob-v2"
    static let sealLabel = "Psyche Helper Touch ID key seal (v2)"

    /// nil: the login keychain at its fixed path, whatever the default keychain is.
    public var keychainPath: String?
    /// Tests: never let macOS show a prompt; a program the list does not trust gets an error.
    public var interactionAllowed: Bool

    public init(keychainPath: String? = nil, interactionAllowed: Bool = true) {
        self.keychainPath = keychainPath
        self.interactionAllowed = interactionAllowed
    }

    /// The login keychain by its fixed path under the user's real home folder (the passwd entry, not
    /// $HOME), never "the default keychain" or the search list, which a program can reorder.
    static func loginKeychainPath() -> String {
        let home = passwdHome()
        let db = home + "/Library/Keychains/login.keychain-db"
        return FileManager.default.fileExists(atPath: db) ? db : home + "/Library/Keychains/login.keychain"
    }

    static func passwdHome() -> String {
        getpwuid(geteuid()).flatMap { $0.pointee.pw_dir.map { String(cString: $0) } } ?? NSHomeDirectory()
    }

    /// Why `file` is not the real login keychain of `home`, or nil. Every folder from the home folder
    /// down (home, Library, Keychains) must be a real directory owned by this user, never a link; the
    /// file must be a regular file owned by this user; and its canonical path must be exactly
    /// `<canonical home>/Library/Keychains/<its name>`, so a link anywhere above it, or another
    /// user-owned keychain file at a different place, does not pass.
    static func pinProblem(file: String, home: String) -> String? {
        for dir in [home, home + "/Library", home + "/Library/Keychains"] {
            var st = stat()
            guard lstat(dir, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == geteuid() else {
                return "\(dir) is a link or not yours"
            }
        }
        guard isOwnRegularFile(file) else { return "the keychain file is a link or not yours" }
        let name = (file as NSString).lastPathComponent
        guard name == "login.keychain-db" || name == "login.keychain" else { return "not the login keychain file" }
        guard let realHome = realpath(home, nil) else { return "the home folder cannot be resolved" }
        defer { free(realHome) }
        guard let realFile = realpath(file, nil) else { return "the keychain file cannot be resolved" }
        defer { free(realFile) }
        guard String(cString: realFile) == String(cString: realHome) + "/Library/Keychains/" + name else {
            return "the keychain file is not at the login keychain's place"
        }
        return nil
    }

    /// The pinned keychain, after checking its file (see `pinProblem`; a test keychain only gets the
    /// regular-file-owned-by-us check).
    private func keychain() throws -> SecKeychain {
        if !interactionAllowed { SecKeychainSetUserInteractionAllowed(false) }
        let requested = keychainPath ?? Self.loginKeychainPath()
        if keychainPath == nil, let problem = Self.pinProblem(file: requested, home: Self.passwdHome()) {
            throw PresenceKeyErrors.untrusted(problem)
        }
        // The path we ask for, as a link or foreign file would show; then the one the keychain reports.
        guard Self.isOwnRegularFile(requested) else { throw PresenceKeyErrors.untrusted("the login keychain file is a link or not yours") }
        var kc: SecKeychain?
        let status = SecKeychainOpen(requested, &kc)
        guard status == errSecSuccess, let kc else { throw KeychainStatus.error(from: KeychainOSStatusError(status)) }
        var len: UInt32 = 1024
        var buf = [CChar](repeating: 0, count: 1024)
        guard SecKeychainGetPath(kc, &len, &buf) == errSecSuccess else { throw PresenceKeyErrors.untrusted("the keychain has no path") }
        let reported = String(cString: buf)
        guard Self.isOwnRegularFile(reported) else { throw PresenceKeyErrors.untrusted("the login keychain file is a link or not yours") }
        if keychainPath == nil, let problem = Self.pinProblem(file: reported, home: Self.passwdHome()) {
            throw PresenceKeyErrors.untrusted(problem)
        }
        return kc
    }

    static func isOwnRegularFile(_ path: String) -> Bool {
        var st = stat()
        return lstat(path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFREG && st.st_uid == geteuid()
    }

    private func itemQuery(_ kc: SecKeychain) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecUseDataProtectionKeychain as String: false,
            kSecMatchSearchList as String: [kc],
        ]
    }

    private func sealQuery(_ kc: SecKeychain) -> [String: Any] {
        [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
            kSecAttrLabel as String: Self.sealLabel,
            kSecUseDataProtectionKeychain as String: false,
            kSecMatchSearchList as String: [kc],
        ]
    }

    static func mapped(_ status: OSStatus) -> Error {
        if status == errSecAuthFailed || status == errSecInteractionNotAllowed || status == errSecUserCanceled
            || status == errSecNotAvailable
        {
            return PresenceKeyErrors.accessDenied
        }
        return KeychainStatus.error(from: KeychainOSStatusError(status))
    }

    /// Every ref matching `query` (any number, none included).
    private func refs(_ query: [String: Any]) throws -> [CFTypeRef] {
        var q = query
        q[kSecReturnRef as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw Self.mapped(status) }
        return (out as? [CFTypeRef]) ?? (out.map { [$0] } ?? [])
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
            if auths.contains(kSecACLAuthorizationChangeACL as String) || auths.contains(kSecACLAuthorizationPartitionID as String) { continue }
            var apps: CFArray?
            var desc: CFString?
            var sel = SecKeychainPromptSelector()
            SecACLCopyContents(acl, &apps, &desc, &sel)
            SecACLSetContents(acl, [app] as CFArray, (desc ?? label as CFString), sel)
        }
        return access
    }

    private final class PublicKeyBox: @unchecked Sendable {
        let key: SecKey
        init(_ key: SecKey) { self.key = key }
        func verify(_ message: Data, _ signature: Data) -> Bool {
            var error: Unmanaged<CFError>?
            let ok = SecKeyVerifySignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, signature as CFData, &error)
            error?.release()
            return ok
        }
    }

    /// The one item and the one seal key, audited; or why not. All from the same refs.
    private struct Found {
        var item: CFTypeRef?
        var seal: SecKey?
        var problem: String?
    }

    private func find(_ kc: SecKeychain) throws -> Found {
        let items = try refs(itemQuery(kc))
        let seals = try refs(sealQuery(kc))
        if items.isEmpty && seals.isEmpty { return Found() }
        if items.count > 1 { return Found(problem: "more than one Touch ID key item") }
        if seals.count > 1 { return Found(problem: "more than one seal key") }
        guard let item = items.first, let seal = seals.first else {
            return Found(problem: items.isEmpty ? "the key item is missing" : "the seal key is missing")
        }
        guard AclAudit.namesOnlyThisProgram(item), AclAudit.namesOnlyThisProgram(seal) else {
            return Found(problem: "an access list names another program or is open")
        }
        return Found(item: item, seal: (seal as! SecKey))  // swiftlint:disable:this force_cast
    }

    public func read() throws -> AclStoreRead {
        let kc = try keychain()
        let found = try find(kc)
        if let problem = found.problem { return .untrusted(problem) }
        guard let item = found.item, let seal = found.seal else { return .absent }
        guard let pub = SecKeyCopyPublicKey(seal) else { return .untrusted("the seal key has no public key") }
        // The data of the very item that was audited.
        let q: [String: Any] = [
            kSecValueRef as String: item,
            kSecReturnData as String: true,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else { throw Self.mapped(status) }
        let box = PublicKeyBox(pub)
        return .trusted(payload: data, verify: { box.verify($0, $1) })
    }

    public func create(_ build: (_ seal: (Data) throws -> Data) throws -> Data) throws {
        let kc = try keychain()
        // Anything of ours that exists is never reused or overwritten here.
        let found = try find(kc)
        if found.problem != nil || found.item != nil { throw PresenceKeyErrors.untrusted(found.problem ?? "a key is already stored") }
        var attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrIsPermanent as String: true,
            kSecAttrLabel as String: Self.sealLabel,
            kSecAttrAccess as String: try Self.ownAccess(label: Self.sealLabel),
            kSecUseKeychain as String: kc,
        ]
        var error: Unmanaged<CFError>?
        guard let sealKey = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else { throw PresenceKey.failure(error?.takeRetainedValue()) }
        attrs.removeAll()
        let payload = try build { message in try Self.sign(sealKey, message) }
        var add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecUseDataProtectionKeychain as String: false,
            kSecUseKeychain as String: kc,
            kSecValueData as String: payload,
            kSecAttrLabel as String: "Psyche Helper Touch ID key",
            kSecAttrAccess as String: try Self.ownAccess(label: "Psyche Helper Touch ID key"),
        ]
        let added = SecItemAdd(add as CFDictionary, nil)
        add.removeAll()
        guard added == errSecSuccess else { throw Self.mapped(added) }
    }

    static func sign(_ key: SecKey, _ message: Data) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) as Data? else {
            let code = error.map { CFErrorGetCode($0.takeUnretainedValue()) } ?? 0
            throw Self.mapped(OSStatus(code))
        }
        return sig
    }

    public func rewrite(_ build: (_ seal: (Data) throws -> Data) throws -> Data) throws {
        let kc = try keychain()
        let found = try find(kc)
        if let problem = found.problem { throw PresenceKeyErrors.untrusted(problem) }
        guard let item = found.item, let seal = found.seal else { throw PresenceKeyErrors.untrusted("the key is gone") }
        let payload = try build { message in try Self.sign(seal, message) }
        let status = SecItemUpdate(
            [kSecValueRef as String: item] as CFDictionary,
            [kSecValueData as String: payload] as CFDictionary
        )
        guard status == errSecSuccess else { throw Self.mapped(status) }
    }

    public func reset() throws {
        let kc = try keychain()
        for q in [itemQuery(kc), sealQuery(kc)] {
            let status = SecItemDelete(q.merging([kSecMatchLimit as String: kSecMatchLimitAll]) { $1 } as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.mapped(status) }
        }
    }
}

/// Reads an item's access list (`SecKeychainItemCopyAccess` family, deprecated) and answers whether
/// every entry that matters trusts only this program, by its exact resolved path.
enum AclAudit {
    static func ownPath() -> String? {
        var size: UInt32 = 0
        _NSGetExecutablePath(nil, &size)
        var buf = [CChar](repeating: 0, count: Int(size))
        guard _NSGetExecutablePath(&buf, &size) == 0 else { return nil }
        return URL(fileURLWithPath: String(cString: buf)).resolvingSymlinksInPath().path
    }

    /// A trusted-application entry is this program: its recorded path is exactly the running
    /// executable's resolved path. (No "satisfies our requirement at that path" branch: a symlink or a
    /// later swap of the file at another path would defeat it.)
    static func isThisProgram(_ entryPath: String, ownPath: String?) -> Bool {
        guard let ownPath, entryPath.hasPrefix("/") else { return false }
        return entryPath == ownPath
    }

    static func entryPath(_ app: SecTrustedApplication) -> String? {
        var data: CFData?
        guard SecTrustedApplicationCopyData(app, &data) == errSecSuccess, let data = data as Data? else { return nil }
        return String(data: data.prefix { $0 != 0 }, encoding: .utf8)
    }

    /// What one ACL entry means for the audit.
    enum Verdict: Equatable {
        case skip
        case ok(isRead: Bool)
        case reject
    }

    /// Pure decision over one entry: its authorizations, its application list (nil = any program) and
    /// the resolved path of each listed application.
    static func judge(auths: [String], apps: [String?]?, ownPath: String?) -> Verdict {
        // Writing the data is never guarded by the list, so this entry says nothing.
        if auths == [kSecACLAuthorizationEncrypt as String] { return .skip }
        // securityd adds a partition-id entry (teamid:/cdhash:/apple:). It only narrows who may use
        // the item (it is checked in addition to the application list), and its list may be nil, so
        // it is neither required nor allowed to reject the helper's own items.
        if auths == [kSecACLAuthorizationPartitionID as String] { return .skip }
        guard let apps else { return .reject }  // nil: any program
        let isChange = auths.contains(kSecACLAuthorizationChangeACL as String)
        if !isChange && apps.isEmpty { return .reject }
        for entry in apps {
            guard let entry, isThisProgram(entry, ownPath: ownPath) else { return .reject }
        }
        return .ok(isRead: !isChange)
    }

    static func namesOnlyThisProgram(_ ref: CFTypeRef) -> Bool {
        let path = ownPath()
        var access: SecAccess?
        guard SecKeychainItemCopyAccess(unsafeBitCast(ref, to: SecKeychainItem.self), &access) == errSecSuccess, let access else { return false }
        var list: CFArray?
        guard SecAccessCopyACLList(access, &list) == errSecSuccess, let acls = list as? [SecACL] else { return false }
        var sawRead = false
        for acl in acls {
            let auths = (SecACLCopyAuthorizations(acl) as? [String]) ?? []
            var apps: CFArray?
            var desc: CFString?
            var sel = SecKeychainPromptSelector()
            let copied = SecACLCopyContents(acl, &apps, &desc, &sel)
            let listed: [String?]? = copied == errSecSuccess ? (apps as? [SecTrustedApplication])?.map(entryPath) : nil
            switch judge(auths: auths, apps: listed, ownPath: path) {
            case .skip: continue
            case .reject: return false
            case .ok(let isRead): sawRead = sawRead || isRead
            }
        }
        return sawRead
    }
}
