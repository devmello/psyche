import CryptoKit
import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheProtocol
import Security

/// Which presence key signs: the data-protection keychain one (`PresenceKey`), or the Secure
/// Enclave key whose wrapped blob is a file (`EnclaveFilePresenceKey`) on builds without a
/// provisioning profile. `presence.public_key` reports it; Settings → Devices shows it.
public enum PresenceKeyKind: String, Sendable {
    case keychain
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
    /// signature over `message` with that same context (one prompt).
    func sign(blob: Data, message: Data, reason: String) async throws -> Data
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

    public func sign(blob: Data, message: Data, reason: String) async throws -> Data {
        let ctx = LAContext()
        ctx.touchIDAuthenticationAllowableReuseDuration = 0
        do {
            _ = try await ctx.evaluateAccessControl(try PresenceKey.accessControl(), operation: .useKeySign, localizedReason: reason)
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
            return try key.signature(for: message).derRepresentation
        } catch let e as CapabilityError {
            throw e
        } catch {
            throw KeychainStatus.error(from: error)
        }
    }
}

/// The Secure Enclave presence key kept as a wrapped blob in
/// `~/Library/Application Support/Psyche Helper/presence/presence-key.se` (directory 0700, file
/// 0600, owned by this user, never a symlink). Used only when the keychain key cannot exist
/// (`missing_entitlement`, see `PreferredPresenceKey`).
///
/// Limit (security §10): any process running as this user can read the blob and ask the Secure
/// Enclave to sign with it, behind its own Touch ID prompt and wording. The keychain key is bound
/// to the helper's access group instead. Same trust boundary as pairing: a same-user process can
/// already pair as a helper with the handshake secret.
public final class EnclaveFilePresenceKey: PresenceSigning, @unchecked Sendable {
    public let path: String
    private let backend: any EnclaveKeyBackend
    private let expectedOwner: uid_t
    private let lock = NSLock()

    public var keyKind: PresenceKeyKind { .enclaveFile }

    public init(path: String = EnclaveFilePresenceKey.defaultPath(), backend: any EnclaveKeyBackend = SecureEnclaveBackend(), expectedOwner: uid_t = geteuid()) {
        self.path = path
        self.backend = backend
        self.expectedOwner = expectedOwner
    }

    public static func defaultPath() -> String {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return support.appendingPathComponent("Psyche Helper/presence/presence-key.se").path
    }

    var directory: String { (path as NSString).deletingLastPathComponent }

    /// The blob, created on first use.
    func blob() throws -> Data {
        try lock.withLock {
            if let existing = try load() { return existing }
            let created = try backend.create()
            try save(created)
            // A concurrent creator may have won the link: use whatever is on disk now.
            return try load() ?? created
        }
    }

    public func publicKey() throws -> (x963: Data, keyId: String) {
        let x963 = try backend.publicKey(blob: try blob())
        return (x963, PresenceMessage.keyId(x963: x963))
    }

    public func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        guard PresenceMessage.isValidChallenge(challenge) else {
            throw CapabilityError.invalidParams("presenceChallenge must be 64 hex characters", field: "presenceChallenge")
        }
        let b = try blob()
        let der = try await backend.sign(blob: b, message: PresenceMessage.bytes(challenge: challenge), reason: reason)
        return PresenceSignature(signature: Base64URL.encode(der), keyId: PresenceMessage.keyId(x963: try backend.publicKey(blob: b)))
    }

    // MARK: File

    private func failure(_ what: String) -> CapabilityError {
        CapabilityError(.errorCodeInternal, reason: "presence_key_file", "Touch ID key file \(path): \(what)")
    }

    func load() throws -> Data? {
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
        return try FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd()
    }

    func save(_ data: Data) throws {
        try ensureDirectory()
        let tmp = path + ".tmp-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw failure(String(cString: strerror(errno))) }
        defer { unlink(tmp) }
        let written = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        let ok = written == data.count && fchmod(fd, 0o600) == 0 && fsync(fd) == 0
        close(fd)
        guard ok else { throw failure("could not be written") }
        // link(2) never replaces an existing key.
        guard link(tmp, path) == 0 || errno == EEXIST else { throw failure(String(cString: strerror(errno))) }
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

/// The keychain key whenever the build can hold it; the Secure Enclave file key only when the
/// keychain answers `missing_entitlement` (no provisioning profile). The choice is made once per
/// process, so one helper never signs with both.
public final class PreferredPresenceKey: PresenceSigning, @unchecked Sendable {
    private let primary: any PresenceSigning
    private let fallback: any PresenceSigning
    private let lock = NSLock()
    private var chosen: (any PresenceSigning)?

    public init(primary: any PresenceSigning, fallback: any PresenceSigning) {
        self.primary = primary
        self.fallback = fallback
    }

    func active() throws -> any PresenceSigning {
        try lock.withLock {
            if let chosen { return chosen }
            let pick: any PresenceSigning
            do {
                _ = try primary.publicKey()
                pick = primary
            } catch let e as CapabilityError where e.reason == "missing_entitlement" {
                pick = fallback
            }
            chosen = pick
            return pick
        }
    }

    public var keyKind: PresenceKeyKind { (try? active())?.keyKind ?? primary.keyKind }

    public func publicKey() throws -> (x963: Data, keyId: String) { try active().publicKey() }

    public func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        try await active().sign(challenge: challenge, reason: reason)
    }
}
