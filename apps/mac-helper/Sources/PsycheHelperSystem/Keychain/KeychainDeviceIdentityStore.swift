import Foundation
import PsycheHelperCore

/// The device identity as a data-protection keychain item (generic password, service
/// `com.psyche.helper.identity`, `AfterFirstUnlockThisDeviceOnly`, no user presence: it is needed at
/// launch, before anyone can answer a prompt). Errors are `KeychainOSStatusError`s.
public struct KeychainDeviceIdentityStore: DeviceIdentityStore {
    public let backend: any KeychainBackend
    public let accessGroup: String?

    public var kind: String { "keychain" }

    public init(backend: any KeychainBackend = SecItemKeychainBackend(), accessGroup: String? = KeychainAccessGroup.resolve()) {
        self.backend = backend
        self.accessGroup = accessGroup
    }

    public func load() throws -> DeviceIdentity? {
        do {
            let data = try backend.copyData(KeychainQueries.readIdentity(accessGroup: accessGroup), prompt: nil, canceller: nil)
            return try FileDeviceIdentityStore.decode(data)
        } catch let e as KeychainOSStatusError where e.isNotFound {
            return nil
        }
    }

    public func save(_ identity: DeviceIdentity) throws {
        do {
            try backend.add(KeychainQueries.addIdentity(accessGroup: accessGroup), value: Data(FileDeviceIdentityStore.encode(identity).utf8))
        } catch let e as KeychainOSStatusError where e.isDuplicate {
            throw DeviceIdentityStoreError.alreadyExists
        }
    }

    public func remove() throws {
        do {
            try backend.delete(KeychainQueries.deleteIdentity(accessGroup: accessGroup))
        } catch let e as KeychainOSStatusError where e.isNotFound {}
    }
}

/// Picks where the device identity lives: the data-protection keychain when the build has a keychain
/// access group entitlement, else (`errSecMissingEntitlement`) the 0600 file store. A key found in
/// the file store while the keychain is usable is moved into the keychain, so pairing survives the
/// switch to a signed build. Logs `identity_store=keychain|file`, never key material.
public enum DeviceIdentityStores {
    public struct Resolved: Sendable {
        public var identity: DeviceIdentity
        public var store: any DeviceIdentityStore
    }

    public static func resolve(
        log: HelperLog,
        keychain: any DeviceIdentityStore = KeychainDeviceIdentityStore(),
        file: any DeviceIdentityStore = FileDeviceIdentityStore()
    ) throws -> Resolved {
        do {
            let identity = try loadFromKeychain(keychain: keychain, file: file, log: log)
            log.info("identity_store=\(keychain.kind)")
            return Resolved(identity: identity, store: keychain)
        } catch let e as KeychainOSStatusError where e.isMissingEntitlement {
            let identity = try file.loadOrCreate()
            log.info("identity_store=\(file.kind) (data-protection keychain unavailable: missing_entitlement)")
            return Resolved(identity: identity, store: file)
        }
    }

    private static func loadFromKeychain(keychain: any DeviceIdentityStore, file: any DeviceIdentityStore, log: HelperLog) throws -> DeviceIdentity {
        if let existing = try keychain.load() { return existing }
        let legacy: DeviceIdentity?
        do {
            legacy = try file.load()
        } catch {
            // An unreadable or over-permissive key file is not trusted; start a fresh identity.
            log.error("identity_migration=skipped (\(error))")
            legacy = nil
        }
        guard let legacy else { return try keychain.loadOrCreate() }
        do {
            try keychain.save(legacy)
        } catch DeviceIdentityStoreError.alreadyExists {
            guard let winner = try keychain.load() else { throw DeviceIdentityStoreError.malformed }
            return winner
        }
        do {
            try file.remove()
            log.info("identity_migration=file_to_keychain")
        } catch {
            log.error("identity_migration=copied (could not remove the key file: \(error))")
        }
        return legacy
    }
}
