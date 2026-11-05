import CryptoKit
import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheProtocol
import PsycheWire
import Security

/// Which presence key signs: the data-protection keychain one (`PresenceKey`); the Secure Enclave
/// key whose wrapped blob is a login-keychain item only the helper may read
/// (`EnclaveKeychainAclPresenceKey`) on builds without a provisioning profile; or, in development
/// builds only, one whose blob is a file (`EnclaveFilePresenceKey`). `presence.public_key` reports
/// it; Settings → Devices shows it.
public enum PresenceKeyKind: String, Sendable {
    case keychain
    case enclaveKeychainAcl = "enclave_keychain_acl"
    case enclaveFile = "enclave_file"
}

extension PresenceSigning {
    public var keyKind: PresenceKeyKind { .keychain }
}

/// What the file-backed key needs from the Secure Enclave; tests swap in a software key.
public protocol EnclaveKeyBackend: Sendable {
    /// A new key, as its wrapped blob (only this Mac's Secure Enclave can use it).
    func create() throws -> Data
    /// X9.63 uncompressed public key of a blob. Never prompts.
    func publicKey(blob: Data) throws -> Data
    /// Touch ID for the key's access control with `reason`, then an ECDSA P-256 / SHA-256 DER
    /// signature over `message` with that same context (one prompt). Throws
    /// `PresenceKeyErrors.refused` when Touch ID passed but the Secure Enclave refused the key.
    func sign(blob: Data, message: Data, reason: String) async throws -> Data
    /// True when the key signs a nonce with no authentication at all (no Touch ID requirement), so it
    /// is not a key this helper made. Never shows UI. Default false (tests' software keys).
    func signsWithoutAuthentication(blob: Data) -> Bool
}

extension EnclaveKeyBackend {
    public func signsWithoutAuthentication(blob: Data) -> Bool { false }
}

/// CryptoKit's Secure Enclave key: works without a keychain access group, so builds without a
/// provisioning profile still get presence. Same access control as `PresenceKey`:
/// `[.privateKeyUsage, .biometryCurrentSet]`, no passcode fallback; every signature needs a current
/// fingerprint inside the Secure Enclave, whoever holds the blob.
public struct SecureEnclaveBackend: EnclaveKeyBackend {
    public init() {}

    public func create() throws -> Data {
        guard SecureEnclave.isAvailable else {
            throw CapabilityError.unavailable("no_secure_enclave", "This Mac has no Secure Enclave for a Touch ID key.")
        }
        do {
            return try SecureEnclave.P256.Signing.PrivateKey(accessControl: try PresenceKey.accessControl()).dataRepresentation
        } catch let e as CapabilityError {
            throw e
        } catch {
            throw KeychainStatus.error(from: error)
        }
    }

    public func publicKey(blob: Data) throws -> Data {
        do {
            return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob).publicKey.x963Representation
        } catch {
            throw CapabilityError(.errorCodeInternal, reason: "presence_key", "The Touch ID key file can't be used on this Mac")
        }
    }

    public func signsWithoutAuthentication(blob: Data) -> Bool {
        // interactionNotAllowed: a key that needs Touch ID fails here instead of showing the sheet.
        let ctx = LAContext()
        ctx.interactionNotAllowed = true
        guard let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx) else { return false }
        return (try? key.signature(for: Data("psyche-presence-probe".utf8))) != nil
    }

    public func sign(blob: Data, message: Data, reason: String) async throws -> Data {
        let ctx = LAContext()
        ctx.touchIDAuthenticationAllowableReuseDuration = 0
        do {
            _ = try await ctx.evaluateAccessControl(try PresenceKey.accessControl(), operation: .useKeySign, localizedReason: reason)
        } catch let e as CapabilityError {
            throw e
        } catch {
            throw KeychainStatus.error(from: error)
        }
        // Touch ID passed: a failure from here on is the Secure Enclave refusing the key.
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
            return try key.signature(for: message).derRepresentation
        } catch {
            throw PresenceKeyErrors.refused
        }
    }
}

/// Keeps the secret that seals the key file to this helper: a random HMAC key in the login
/// (file-based) keychain, which needs no access group. The keychain trusts the program that made
/// the item (its code signature's designated requirement), so another program reading it gets a
/// macOS prompt, and a key file sealed by anyone else is refused (security §10).
public protocol PresenceFileSealer: Sendable {
    /// A new secret for a new key file, replacing any earlier one.
    func newSecret() throws -> SymmetricKey
    /// The current secret, or nil when there is none.
    func secret() throws -> SymmetricKey?
    func removeSecret()
}

public struct LoginKeychainSealer: PresenceFileSealer {
    static let service = "com.psyche.helper.presence-file"
    static let account = "hmac-v1"

    public init() {}

    private var base: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecUseDataProtectionKeychain as String: false,
        ]
    }

    public func newSecret() throws -> SymmetricKey {
        removeSecret()
        let key = SymmetricKey(size: .bits256)
        var add = base
        add[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        add[kSecAttrLabel as String] = "Psyche Helper Touch ID key seal"
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainStatus.error(from: KeychainOSStatusError(status)) }
        return key
    }

    public func secret() throws -> SymmetricKey? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data, data.count == 32 else {
            throw KeychainStatus.error(from: KeychainOSStatusError(status))
        }
        return SymmetricKey(data: data)
    }

    public func removeSecret() {
        SecItemDelete(base as CFDictionary)
    }
}

/// The Secure Enclave presence key kept as a wrapped blob in
/// `~/Library/Application Support/Psyche Helper/presence/presence-key.se` (directory 0700, file
/// 0600, owned by this user, never a symlink). Used only when the keychain key cannot exist
/// (`missing_entitlement`, see `PreferredPresenceKey`), and only in builds made with the fallback.
///
/// The file is `PSYPK1`, an HMAC-SHA256 over the rest, the enrollment state the key was made under
/// and the blob. The HMAC key is `PresenceFileSealer`'s secret, so a blob planted by another
/// process (one made without biometry, say) does not verify: it is set aside
/// (`presence-key.se.rejected`) and the helper makes its own. Once loaded, the public key is pinned
/// for the life of the process; a different key on disk is refused until the helper restarts.
///
/// Limit (security §10): a same-user process can still read the blob and ask the Secure Enclave to
/// sign with it behind its own Touch ID prompt and wording; the keychain key is bound to the
/// helper's access group instead. Same trust boundary as pairing: a same-user process can already
/// pair as a helper with the handshake secret.
public final class EnclaveFilePresenceKey: PresenceSigning, @unchecked Sendable {
    public let path: String
    private let backend: any EnclaveKeyBackend
    private let sealer: any PresenceFileSealer
    private let biometry: any BiometryStateSource
    private let expectedOwner: uid_t
    private let lock = NSLock()
    private var pinned: Data?

    static let magic = Data("PSYPK1".utf8)

    public var keyKind: PresenceKeyKind { .enclaveFile }

    public init(
        path: String = EnclaveFilePresenceKey.defaultPath(), backend: any EnclaveKeyBackend = SecureEnclaveBackend(),
        sealer: any PresenceFileSealer = LoginKeychainSealer(), biometry: any BiometryStateSource = LiveBiometryState(),
        expectedOwner: uid_t = geteuid()
    ) {
        self.path = path
        self.backend = backend
        self.sealer = sealer
        self.biometry = biometry
        self.expectedOwner = expectedOwner
    }

    public static func defaultPath() -> String {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Psyche Helper/presence/presence-key.se").path
    }

    var directory: String { (path as NSString).deletingLastPathComponent }

    struct Sealed: Equatable {
        var state: Data
        var blob: Data
    }

    /// The verified key (made on first use), pinned for this process.
    func current() throws -> (sealed: Sealed, x963: Data) {
        try lock.withLock {
            var loaded: Sealed?
            do {
                loaded = try load()
            } catch let e as CapabilityError where e.reason == "presence_key_unsealed" && pinned == nil {
                // Not this helper's: set it aside and make our own (never adopt it).
                _ = rename(path, path + ".rejected")
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
            let made = Sealed(state: biometry.current() ?? Data(), blob: try backend.create())
            try save(made, secret: try sealer.newSecret())
            guard let onDisk = try load() else { throw failure("presence_key_file", "could not be read back") }
            let x963 = try backend.publicKey(blob: onDisk.blob)
            pinned = x963
            return (onDisk, x963)
        }
    }

    public func publicKey() throws -> (x963: Data, keyId: String) {
        let x963 = try current().x963
        return (x963, PresenceMessage.keyId(x963: x963))
    }

    /// Read only: nil when there is no key file; never makes or moves one.
    public func existingPublicKey() throws -> (x963: Data, keyId: String)? {
        try lock.withLock {
            guard let loaded = try load() else { return nil }
            let x963 = try backend.publicKey(blob: loaded.blob)
            return (x963, PresenceMessage.keyId(x963: x963))
        }
    }

    public func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        guard PresenceMessage.isValidChallenge(challenge) else {
            throw CapabilityError.invalidParams("presenceChallenge must be 64 hex characters", field: "presenceChallenge")
        }
        let (sealed, x963) = try current()
        // A changed enrollment hash is only a hint (an OS update can change it): still try to sign.
        let now = biometry.current()
        let changed = !sealed.state.isEmpty && now != nil && now != sealed.state
        let der: Data
        do {
            der = try await backend.sign(blob: sealed.blob, message: PresenceMessage.bytes(challenge: challenge), reason: reason)
        } catch let e as CapabilityError where e.reason == PresenceKeyErrors.refused.reason {
            retire()
            throw PresenceKeyErrors.invalidated(enrollmentChanged: changed)
        }
        if changed, let now { try? rerecord(Sealed(state: now, blob: sealed.blob)) }
        return PresenceSignature(signature: Base64URL.encode(der), keyId: PresenceMessage.keyId(x963: x963))
    }

    /// The key still signs under a new enrollment state: seal that state with it.
    func rerecord(_ sealed: Sealed) throws {
        try lock.withLock {
            guard let secret = try sealer.secret() else { return }
            try save(sealed, secret: secret)
        }
    }

    /// Moves a refused key aside (`presence-key.se.retired-<time>`, kept, never deleted); the next
    /// use makes (and pins) a new one.
    func retire() {
        lock.withLock {
            _ = rename(path, path + ".retired-\(Int(Date().timeIntervalSince1970))")
            pinned = nil
        }
    }

    // MARK: File

    private func failure(_ reason: String, _ what: String) -> CapabilityError {
        CapabilityError(.errorCodeInternal, reason: reason, "Touch ID key file \(path): \(what)")
    }

    private func failure(_ what: String) -> CapabilityError { failure("presence_key_file", what) }

    static func mac(_ secret: SymmetricKey, state: Data, blob: Data) -> Data {
        var body = Data()
        body.append(UInt8(state.count >> 8))
        body.append(UInt8(state.count & 0xFF))
        body.append(state)
        body.append(blob)
        return Data(HMAC<SHA256>.authenticationCode(for: body, using: secret))
    }

    /// The sealed key, nil when there is no file. Throws `presence_key_unsealed` for a file this
    /// helper did not seal.
    func load() throws -> Sealed? {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            throw failure(errno == ELOOP ? "is a symlink" : String(cString: strerror(errno)))
        }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0 else { throw failure(String(cString: strerror(errno))) }
        guard (st.st_mode & S_IFMT) == S_IFREG else { throw failure("not a regular file") }
        guard st.st_uid == expectedOwner else { throw failure("owned by another user") }
        guard UInt16(st.st_mode & 0o7777) & ~0o600 == 0 else { throw failure("readable by others (must be 0600)") }
        guard st.st_size > 0, st.st_size <= 16_384 else { throw failure("malformed") }
        let data = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd() ?? Data()
        let unsealed = failure("presence_key_unsealed", "was not sealed by this helper")
        let head = Self.magic.count + 32 + 2
        guard data.count > head, data.prefix(Self.magic.count) == Self.magic else { throw unsealed }
        let mac = data.subdata(in: Self.magic.count..<(Self.magic.count + 32))
        let stateLen = Int(data[Self.magic.count + 32]) << 8 | Int(data[Self.magic.count + 33])
        guard data.count > head + stateLen else { throw unsealed }
        let state = data.subdata(in: head..<(head + stateLen))
        let blob = data.subdata(in: (head + stateLen)..<data.count)
        guard let secret = try sealer.secret(), Self.mac(secret, state: state, blob: blob) == mac else { throw unsealed }
        return Sealed(state: state, blob: blob)
    }

    func save(_ sealed: Sealed, secret: SymmetricKey) throws {
        try ensureDirectory()
        var data = Self.magic
        data.append(Self.mac(secret, state: sealed.state, blob: sealed.blob))
        data.append(UInt8(sealed.state.count >> 8))
        data.append(UInt8(sealed.state.count & 0xFF))
        data.append(sealed.state)
        data.append(sealed.blob)
        let tmp = path + ".tmp-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw failure(String(cString: strerror(errno))) }
        defer { unlink(tmp) }
        let written = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        let ok = written == data.count && fchmod(fd, 0o600) == 0 && fsync(fd) == 0
        close(fd)
        guard ok else { throw failure("could not be written") }
        // rename(2) replaces a key only on this path, after the old one was set aside or discarded.
        guard rename(tmp, path) == 0 else { throw failure(String(cString: strerror(errno))) }
    }

    /// The key directory 0700: created so, or an existing one checked to be ours and tightened.
    func ensureDirectory() throws {
        let dir = directory
        var st = stat()
        if lstat(dir, &st) != 0 {
            guard errno == ENOENT else { throw failure(String(cString: strerror(errno))) }
            do {
                try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            } catch {
                throw failure("its folder could not be created")
            }
            guard lstat(dir, &st) == 0 else { throw failure(String(cString: strerror(errno))) }
        }
        guard (st.st_mode & S_IFMT) == S_IFDIR else { throw failure("its folder is not a directory") }
        guard st.st_uid == expectedOwner else { throw failure("its folder is owned by another user") }
        if st.st_mode & 0o077 != 0, chmod(dir, 0o700) != 0 { throw failure("its folder could not be made private") }
    }
}

/// The data-protection keychain key whenever the build can hold it. Without a provisioning profile
/// (`missing_entitlement`) the login-keychain ACL key (`EnclaveKeychainAclPresenceKey`), in every
/// build. The development file key is used only when the build has it (not
/// `PSYCHE_PUBLIC_RELEASE=1`) and the developer opts in with `PSYCHE_PRESENCE_FILE_KEY=1`
/// (an ad-hoc build is a new program for the keychain on every rebuild). The choice is made once
/// per process, so one helper never signs with two kinds.
public final class PreferredPresenceKey: PresenceSigning, @unchecked Sendable {
    /// Whether this build may use the file key at all: on for development builds, off when built
    /// with `PSYCHE_PUBLIC_RELEASE=1` (Package.swift leaves `PSYCHE_PRESENCE_FILE_FALLBACK` out).
    #if PSYCHE_PRESENCE_FILE_FALLBACK
    public static let fallbackBuiltIn = true
    #else
    public static let fallbackBuiltIn = false
    #endif

    private let primary: any PresenceSigning
    private let aclKey: any PresenceSigning
    private let fileKey: any PresenceSigning
    private let fileKeyAllowed: Bool
    private let lock = NSLock()
    private var chosen: (any PresenceSigning)?

    public init(
        primary: any PresenceSigning, aclKey: any PresenceSigning, fileKey: any PresenceSigning,
        fileKeyAllowed: Bool = PreferredPresenceKey.fallbackBuiltIn && ProcessInfo.processInfo.environment["PSYCHE_PRESENCE_FILE_KEY"] == "1"
    ) {
        self.primary = primary
        self.aclKey = aclKey
        self.fileKey = fileKey
        self.fileKeyAllowed = fileKeyAllowed && Self.fallbackBuiltIn
    }

    public static func live() -> PreferredPresenceKey {
        PreferredPresenceKey(primary: PresenceKey(), aclKey: EnclaveKeychainAclPresenceKey(), fileKey: EnclaveFilePresenceKey())
    }

    func active() throws -> any PresenceSigning {
        try lock.withLock {
            if let chosen { return chosen }
            let pick: any PresenceSigning
            do {
                _ = try primary.existingPublicKey()
                pick = primary
            } catch let e as CapabilityError where e.reason == "missing_entitlement" {
                pick = fileKeyAllowed ? fileKey : aclKey
            }
            chosen = pick
            return pick
        }
    }

    public var keyKind: PresenceKeyKind { (try? active())?.keyKind ?? primary.keyKind }

    public func publicKey() throws -> (x963: Data, keyId: String) { try active().publicKey() }

    public func existingPublicKey() throws -> (x963: Data, keyId: String)? { try active().existingPublicKey() }

    public func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        try await active().sign(challenge: challenge, reason: reason)
    }
}
