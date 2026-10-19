import Foundation
import PsycheHelperCore
import PsycheProtocol
import Security

/// Vault key slots and Psyche-owned items in the data-protection keychain (security §4.2, G1).
///
/// - Vault KEKs: `wrapKey` generates a random 256-bit KEK, stores it under `com.psyche.vault` /
///   `<slot>` with `[.biometryCurrentSet, .or, .devicePasscode]` + `WhenPasscodeSetThisDeviceOnly`
///   (adding needs no prompt) and returns the DEK wrapped under it (`KeyWrap` v1). `unwrapKey`
///   reads the KEK (Touch ID or the login password, reuse duration 0) and opens the blob.
/// - Items: `store` / `retrieve` under `com.psyche.helper.items` / `<name>`.
///
/// There is no fallback to the legacy file-based keychain: without a keychain access group
/// entitlement every operation fails with `unavailable` / `missing_entitlement`.
///
/// All `SecItem*` calls run on a dedicated (concurrent) `DispatchQueue`, never on the cooperative
/// pool: they block, sometimes for as long as the Touch ID sheet is up, and a pending prompt must not
/// stall `status` or other calls. Errors thrown are `CapabilityError`s.
public final class KeychainVault: Sendable {
    public enum Target: Sendable, Equatable {
        case slot(String)
        case item(String)
    }

    public let backend: any KeychainBackend
    public let accessGroup: String?
    private let biometry: @Sendable () -> BiometryStatus
    private let queue = DispatchQueue(label: "com.psyche.helper.keychain", qos: .userInitiated, attributes: .concurrent)

    /// Largest value `store` accepts (decoded bytes).
    public static let maxItemBytes = 16 * 1024

    public init(
        backend: any KeychainBackend = SecItemKeychainBackend(),
        accessGroup: String? = KeychainAccessGroup.resolve(),
        biometry: @escaping @Sendable () -> BiometryStatus = { BiometryStatus.current() }
    ) {
        self.backend = backend
        self.accessGroup = accessGroup
        self.biometry = biometry
    }

    // MARK: - Vault KEKs

    /// Stores a fresh KEK for `slot` and returns `dek` wrapped under it (base64url). Throws
    /// `conflict` / `duplicate_item` if the slot exists, unless `replace` (which makes every blob
    /// previously wrapped for the slot unopenable).
    public func wrapKey(slot: String, dek: Data, replace: Bool = false) async throws -> (wrapped: String, replaced: Bool) {
        let slot = try KeychainNames.validate(slot, field: "slot")
        guard dek.count == KeyWrap.keyByteCount else { throw KeyWrapError.badKeySize(field: "dek", byteCount: dek.count).capabilityError }
        var kek = KeyWrap.generateKEK()
        defer { kek.resetBytes(in: 0..<kek.count) }
        let wrapped: String
        do {
            wrapped = try KeyWrap.wrapBase64URL(dek: dek, kek: kek, slot: slot)
        } catch {
            throw KeychainStatus.error(from: error)
        }
        let replaced = try await addReplacing(
            KeychainQueries.addVaultKEK(slot: slot, accessGroup: accessGroup),
            delete: KeychainQueries.deleteVaultKEK(slot: slot, accessGroup: accessGroup),
            value: kek, replace: replace
        )
        return (wrapped, replaced)
    }

    /// Reads the slot's KEK (prompts Touch ID / password with `reason`) and returns the DEK.
    public func unwrapKey(slot: String, wrapped: String, reason: String) async throws -> Data {
        let slot = try KeychainNames.validate(slot, field: "slot")
        guard let blob = Base64URL.decode(wrapped) else { throw KeyWrapError.malformed.capabilityError }
        // Validate the blob shape before prompting, so a bad blob never costs a Touch ID prompt.
        if blob.first != KeyWrap.version { throw KeyWrapError.unsupportedVersion(blob.first ?? 0).capabilityError }
        guard blob.count == KeyWrap.wrappedByteCount else { throw KeyWrapError.malformed.capabilityError }
        var kek = try await read(KeychainQueries.readVaultKEK(slot: slot, accessGroup: accessGroup), prompt: reason, what: "vault key slot \(slot)")
        defer { kek.resetBytes(in: 0..<kek.count) }
        do {
            return try KeyWrap.unwrap(blob, kek: kek, slot: slot)
        } catch {
            throw KeychainStatus.error(from: error)
        }
    }

    // MARK: - S06 vault contract (keychain.set / vault.unlock / keychain.delete)

    /// Stores the Gateway's KEK for vault `account` (S06 seals the DEK itself). Replaces an
    /// existing item: the vault calls this on creation and on rekey. No prompt.
    public func setVaultKey(account: String, value: Data) async throws -> Bool {
        let account = try KeychainNames.validate(account, field: "account")
        guard (16...64).contains(value.count) else {
            throw CapabilityError.invalidParams("value must be a 16–64 byte key", field: "value")
        }
        return try await addReplacing(
            KeychainQueries.addVaultKEK(slot: account, accessGroup: accessGroup),
            delete: KeychainQueries.deleteVaultKEK(slot: account, accessGroup: accessGroup),
            value: value, replace: true
        )
    }

    /// Reads vault `account`'s KEK, prompting Touch ID / password with `reason`.
    public func unlockVaultKey(account: String, reason: String, reuseSeconds: TimeInterval) async throws -> Data {
        let account = try KeychainNames.validate(account, field: "account")
        return try await read(KeychainQueries.readVaultKEK(slot: account, accessGroup: accessGroup), prompt: reason,
                              what: "vault key \(account)", reuseSeconds: reuseSeconds)
    }

    // MARK: - Items

    /// Stores `value` under `name`. `requireAuth` (default) protects it like a vault KEK; otherwise
    /// it is readable without a prompt while the Mac is unlocked. Returns whether it replaced one.
    public func store(name: String, value: Data, requireAuth: Bool = true, replace: Bool = false) async throws -> Bool {
        let name = try KeychainNames.validate(name, field: "name")
        guard !value.isEmpty, value.count <= Self.maxItemBytes else {
            throw CapabilityError.invalidParams("value must be 1–\(Self.maxItemBytes) bytes", field: "value")
        }
        return try await addReplacing(
            KeychainQueries.addItem(name: name, requireAuth: requireAuth, accessGroup: accessGroup),
            delete: KeychainQueries.deleteItem(name: name, accessGroup: accessGroup),
            value: value, replace: replace
        )
    }

    /// Reads an item (prompts when it was stored with `requireAuth`).
    public func retrieve(name: String, reason: String) async throws -> Data {
        let name = try KeychainNames.validate(name, field: "name")
        return try await read(KeychainQueries.readItem(name: name, accessGroup: accessGroup), prompt: reason, what: "item \(name)")
    }

    /// Deletes a vault slot or an item. Deleting needs no prompt.
    public func delete(_ target: Target) async throws {
        let query: KeychainQuery
        let what: String
        switch target {
        case .slot(let slot):
            query = KeychainQueries.deleteVaultKEK(slot: try KeychainNames.validate(slot, field: "slot"), accessGroup: accessGroup)
            what = "vault key slot \(slot)"
        case .item(let name):
            query = KeychainQueries.deleteItem(name: try KeychainNames.validate(name, field: "name"), accessGroup: accessGroup)
            what = "item \(name)"
        }
        let backend = self.backend
        do {
            try await onQueue { try backend.delete(query) }
        } catch {
            throw Self.notFoundMessage(KeychainStatus.error(from: error), what: what)
        }
    }

    // MARK: - Status

    public struct Status: Sendable, Equatable {
        public enum DataProtection: String, Sendable {
            case available
            case missingEntitlement = "missing_entitlement"
            case error
        }

        public var dataProtection: DataProtection
        /// The probe's OSStatus when it was neither success nor not-found.
        public var probeStatus: OSStatus?
        public var accessGroup: String?
        public var biometry: BiometryStatus

        public var json: JSONValue {
            [
                "dataProtectionKeychain": .string(dataProtection.rawValue),
                "probeStatus": probeStatus.map { .int(Int($0)) } ?? .null,
                "accessGroup": accessGroup.map { .string($0) } ?? .null,
                "biometry": biometry.json,
            ]
        }
    }

    /// Whether the data-protection keychain is usable and biometry is available. Never prompts and
    /// never creates an item (it deletes one that is never created).
    public func status() async -> Status {
        let backend = self.backend
        let probe = KeychainQueries.probe(accessGroup: accessGroup)
        let state: (Status.DataProtection, OSStatus?)
        do {
            try await onQueue { try backend.delete(probe) }
            state = (.available, nil)
        } catch let e as KeychainOSStatusError where e.isNotFound {
            state = (.available, nil)
        } catch let e as KeychainOSStatusError where e.isMissingEntitlement {
            state = (.missingEntitlement, e.status)
        } catch let e as KeychainOSStatusError {
            state = (.error, e.status)
        } catch {
            state = (.error, nil)
        }
        return Status(dataProtection: state.0, probeStatus: state.1, accessGroup: accessGroup, biometry: biometry())
    }

    // MARK: - Plumbing

    private func addReplacing(_ add: KeychainQuery, delete: KeychainQuery, value: Data, replace: Bool) async throws -> Bool {
        let backend = self.backend
        do {
            return try await onQueue {
                do {
                    try backend.add(add, value: value)
                    return false
                } catch let e as KeychainOSStatusError where e.isDuplicate && replace {
                    // Delete + add: SecItemUpdate on an access-controlled item would need authentication.
                    try backend.delete(delete)
                    try backend.add(add, value: value)
                    return true
                }
            }
        } catch {
            throw KeychainStatus.error(from: error)
        }
    }

    private func read(_ query: KeychainQuery, prompt: String, what: String, reuseSeconds: TimeInterval = 0) async throws -> Data {
        let backend = self.backend
        let probe = KeychainQueries.probe(accessGroup: accessGroup)
        let canceller = AuthenticationCanceller()
        do {
            let data = try await withTaskCancellationHandler {
                try await onQueue { () throws -> Data in
                    do {
                        return try backend.copyData(query, prompt: prompt, reuseSeconds: reuseSeconds, canceller: canceller)
                    } catch let e as KeychainOSStatusError where e.isNotFound {
                        // Unentitled reads of absent items report not-found; tell the two apart.
                        do {
                            try backend.delete(probe)
                        } catch let p as KeychainOSStatusError where p.isMissingEntitlement {
                            throw p
                        } catch {}
                        throw e
                    }
                }
            } onCancel: {
                canceller.cancel()
            }
            if canceller.isCancelled { throw CapabilityError.cancelled }
            return data
        } catch {
            if canceller.isCancelled { throw CapabilityError.cancelled }
            throw Self.notFoundMessage(KeychainStatus.error(from: error), what: what)
        }
    }

    private static func notFoundMessage(_ error: CapabilityError, what: String) -> CapabilityError {
        guard error.reason == "item_not_found" else { return error }
        var e = error
        e.message = "No keychain \(what)"
        return e
    }

    private func onQueue<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try body() }) }
        }
    }
}
