import CryptoKit
import Foundation

/// Where the helper's Ed25519 device identity persists (security §4, §10). The keychain store is
/// preferred; the file store is the fallback for dev builds without a keychain entitlement.
public protocol DeviceIdentityStore: Sendable {
    /// `keychain` or `file` (logged as `identity_store=<kind>`).
    var kind: String { get }
    /// The stored identity, or nil when none exists yet.
    func load() throws -> DeviceIdentity?
    /// Persists a new identity; fails if one already exists.
    func save(_ identity: DeviceIdentity) throws
    /// Removes the stored identity, if any.
    func remove() throws
}

extension DeviceIdentityStore {
    /// Loads the identity, creating and persisting one on first use. If another process created
    /// one concurrently, that one wins.
    public func loadOrCreate() throws -> DeviceIdentity {
        if let existing = try load() { return existing }
        let fresh = DeviceIdentity()
        do {
            try save(fresh)
            return fresh
        } catch DeviceIdentityStoreError.alreadyExists {
            guard let winner = try load() else { throw DeviceIdentityStoreError.malformed }
            return winner
        }
    }
}

public enum DeviceIdentityStoreError: Error, Equatable, Sendable, CustomStringConvertible {
    /// The key file's mode allows more than owner read/write (0600).
    case insecurePermissions(path: String, mode: UInt16)
    /// The key file or its directory is owned by another user.
    case wrongOwner(path: String)
    /// Not a regular file (symlink, directory, …).
    case notRegularFile(path: String)
    /// The stored key is not a base64url 32-byte Ed25519 private key.
    case malformed
    case alreadyExists
    case io(path: String, errno: Int32)

    public var description: String {
        switch self {
        case .insecurePermissions(let path, let mode):
            "refusing device key \(path): mode \(String(mode, radix: 8)) is wider than 0600"
        case .wrongOwner(let path): "refusing device key \(path): owned by another user"
        case .notRegularFile(let path): "refusing device key \(path): not a regular file"
        case .malformed: "device key is malformed"
        case .alreadyExists: "device key already exists"
        case .io(let path, let code): "device key I/O error at \(path): \(String(cString: strerror(code)))"
        }
    }
}

/// Ed25519 raw private key, base64url, in `$PSYCHE_HOME/helper/device.key` (dir 0700, file 0600).
/// Refuses to load a key whose file mode is wider than 0600 or whose owner is not this user.
public struct FileDeviceIdentityStore: DeviceIdentityStore {
    public let path: String
    let expectedOwner: uid_t

    public var kind: String { "file" }

    public init(path: String, expectedOwner: uid_t = geteuid()) {
        self.path = path
        self.expectedOwner = expectedOwner
    }

    public init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.init(path: Self.defaultPath(environment: environment))
    }

    public static func defaultPath(environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        (HelperPaths.psycheHome(environment: environment) as NSString).appendingPathComponent("helper/device.key")
    }

    var directory: String { (path as NSString).deletingLastPathComponent }

    public func load() throws -> DeviceIdentity? {
        let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return nil }
            if errno == ELOOP { throw DeviceIdentityStoreError.notRegularFile(path: path) }
            throw DeviceIdentityStoreError.io(path: path, errno: errno)
        }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0 else { throw DeviceIdentityStoreError.io(path: path, errno: errno) }
        guard (st.st_mode & S_IFMT) == S_IFREG else { throw DeviceIdentityStoreError.notRegularFile(path: path) }
        guard st.st_uid == expectedOwner else { throw DeviceIdentityStoreError.wrongOwner(path: path) }
        let mode = UInt16(st.st_mode & 0o7777)
        guard mode & ~0o600 == 0 else { throw DeviceIdentityStoreError.insecurePermissions(path: path, mode: mode) }

        guard st.st_size <= 4096 else { throw DeviceIdentityStoreError.malformed }
        let data: Data
        do {
            data = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd() ?? Data()
        } catch {
            throw DeviceIdentityStoreError.io(path: path, errno: EIO)
        }
        return try Self.decode(data)
    }

    public func save(_ identity: DeviceIdentity) throws {
        try ensureDirectory()
        let tmp = path + ".tmp-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw DeviceIdentityStoreError.io(path: tmp, errno: errno) }
        defer { unlink(tmp) }
        let bytes = Array(Self.encode(identity).utf8)
        let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        let ok = written == bytes.count && fchmod(fd, 0o600) == 0 && fsync(fd) == 0
        let savedErrno = errno
        close(fd)
        guard ok else { throw DeviceIdentityStoreError.io(path: tmp, errno: savedErrno) }
        // link(2) fails with EEXIST instead of replacing, so a concurrent creator's key survives.
        guard link(tmp, path) == 0 else {
            if errno == EEXIST { throw DeviceIdentityStoreError.alreadyExists }
            throw DeviceIdentityStoreError.io(path: path, errno: errno)
        }
    }

    public func remove() throws {
        guard unlink(path) == 0 || errno == ENOENT else { throw DeviceIdentityStoreError.io(path: path, errno: errno) }
    }

    /// Creates the key directory 0700, or checks that an existing one is ours and tightens it.
    func ensureDirectory() throws {
        let dir = directory
        var st = stat()
        if lstat(dir, &st) != 0 {
            guard errno == ENOENT else { throw DeviceIdentityStoreError.io(path: dir, errno: errno) }
            do {
                try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            } catch {
                throw DeviceIdentityStoreError.io(path: dir, errno: EIO)
            }
            guard lstat(dir, &st) == 0 else { throw DeviceIdentityStoreError.io(path: dir, errno: errno) }
        }
        guard (st.st_mode & S_IFMT) == S_IFDIR else { throw DeviceIdentityStoreError.notRegularFile(path: dir) }
        guard st.st_uid == expectedOwner else { throw DeviceIdentityStoreError.wrongOwner(path: dir) }
        if st.st_mode & 0o777 != 0o700, chmod(dir, 0o700) != 0 {
            throw DeviceIdentityStoreError.io(path: dir, errno: errno)
        }
    }

    // MARK: - Encoding (shared with the keychain store)

    /// base64url raw 32-byte private key.
    public static func encode(_ identity: DeviceIdentity) -> String {
        Base64URL.encode(identity.privateKey.rawRepresentation)
    }

    public static func decode(_ data: Data) throws -> DeviceIdentity {
        guard let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let raw = Base64URL.decode(text), raw.count == 32,
              let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw)
        else { throw DeviceIdentityStoreError.malformed }
        return DeviceIdentity(privateKey: key)
    }
}
