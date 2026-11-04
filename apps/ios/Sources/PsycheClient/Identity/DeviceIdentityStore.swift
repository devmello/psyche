import CryptoKit
import Foundation
import PsycheWire
import Security

/// Where the device's private key bytes live. The Keychain in the app; memory in tests.
public protocol SecretStore: Sendable {
    func read(account: String) throws -> Data?
    func write(_ data: Data, account: String) throws
    func delete(account: String) throws
}

public struct KeychainError: Error, Equatable { public let status: OSStatus }

/// The Keychain, generic-password items, `AfterFirstUnlockThisDeviceOnly` (so lock-screen answers and
/// background launches work after the first unlock), never synchronizable (no iCloud copy: a new phone
/// pairs again; companion doc §5).
public struct KeychainSecretStore: SecretStore {
    public let service: String

    public init(service: String = "com.psyche.ios.device") { self.service = service }

    private func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    public func read(account: String) throws -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return out as? Data
    }

    public func write(_ data: Data, account: String) throws {
        // Update in place when the item exists, add when it does not: never delete first, so a failed write
        // cannot leave the phone without the key it already had.
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(account) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query(account).merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

public final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    public init() {}
    public func read(account: String) throws -> Data? { lock.withLock { items[account] } }
    public func write(_ data: Data, account: String) throws { lock.withLock { items[account] = data } }
    public func delete(account: String) throws { lock.withLock { items[account] = nil } }
}

/// The phone's Ed25519 device key. Created on first use, stored in the Keychain, wiped on revoke or
/// unpair. The key signs `connect.verify`; it never leaves the device.
public actor DeviceIdentityStore {
    private let store: any SecretStore
    private let account = "ed25519-device-key"
    private var cached: DeviceIdentity?

    public init(store: any SecretStore = KeychainSecretStore()) { self.store = store }

    /// The existing identity, creating and persisting one the first time.
    public func identity() throws -> DeviceIdentity {
        if let cached { return cached }
        if let raw = try store.read(account: account),
           let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) {
            let id = DeviceIdentity(privateKey: key)
            cached = id
            return id
        }
        let key = Curve25519.Signing.PrivateKey()
        try store.write(key.rawRepresentation, account: account)
        let id = DeviceIdentity(privateKey: key)
        cached = id
        return id
    }

    /// Forgets the key (revoked, or the owner unpaired). The next `identity()` makes a new one.
    public func wipe() throws {
        cached = nil
        try store.delete(account: account)
    }
}
