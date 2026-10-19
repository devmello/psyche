import Foundation
import Security

/// Keychain services Psyche uses. Every item is a generic password in the data-protection keychain.
public enum KeychainService: String, Sendable, CaseIterable {
    /// Vault key-encryption keys (`keychain.wrap_key` / `unwrap_key`), account = slot.
    case vault = "com.psyche.vault"
    /// Items stored with `keychain.store` / `retrieve`, account = name.
    case items = "com.psyche.helper.items"
    /// The helper's Ed25519 device identity (read at launch, no user presence).
    case identity = "com.psyche.helper.identity"
    /// Never-created item used to probe whether the data-protection keychain is usable.
    case probe = "com.psyche.helper.probe"
}

/// `kSecAttrAccessible*` classes Psyche uses.
public enum KeychainAccessibility: String, Sendable, CaseIterable {
    case whenPasscodeSetThisDeviceOnly
    case whenUnlockedThisDeviceOnly
    case afterFirstUnlockThisDeviceOnly

    /// The Security framework constant's value.
    public var secValue: String {
        switch self {
        case .whenPasscodeSetThisDeviceOnly: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly as String
        case .whenUnlockedThisDeviceOnly: kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String
        case .afterFirstUnlockThisDeviceOnly: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        }
    }
}

/// Mirror of `SecAccessControlCreateFlags` (kept Sendable and comparable for tests).
public struct KeychainAccessFlags: OptionSet, Sendable, Hashable {
    public let rawValue: UInt
    public init(rawValue: UInt) { self.rawValue = rawValue }

    public static let userPresence = KeychainAccessFlags(rawValue: SecAccessControlCreateFlags.userPresence.rawValue)
    public static let biometryCurrentSet = KeychainAccessFlags(rawValue: SecAccessControlCreateFlags.biometryCurrentSet.rawValue)
    public static let devicePasscode = KeychainAccessFlags(rawValue: SecAccessControlCreateFlags.devicePasscode.rawValue)
    public static let or = KeychainAccessFlags(rawValue: SecAccessControlCreateFlags.or.rawValue)
    public static let and = KeychainAccessFlags(rawValue: SecAccessControlCreateFlags.and.rawValue)

    /// The vault policy (security §4.2): Touch ID with the currently enrolled fingers, or the login
    /// password. `.or` is required; without it the constraints are ANDed.
    public static let biometryOrPasscode: KeychainAccessFlags = [.biometryCurrentSet, .or, .devicePasscode]

    public var secFlags: SecAccessControlCreateFlags { SecAccessControlCreateFlags(rawValue: rawValue) }
}

/// How an item added to the keychain is protected. Exactly one of `kSecAttrAccessControl` (which
/// carries its own accessibility) or `kSecAttrAccessible` ends up in the query, never both.
public enum KeychainProtection: Equatable, Sendable {
    case accessControl(KeychainAccessibility, KeychainAccessFlags)
    case accessible(KeychainAccessibility)

    /// Vault KEKs and `requireAuth` items.
    public static let userPresence = KeychainProtection.accessControl(.whenPasscodeSetThisDeviceOnly, .biometryOrPasscode)
}

/// One value in a rendered query; the System layer turns it into a CF object.
public enum KeychainQueryValue: Equatable, Sendable {
    case string(String)
    case bool(Bool)
    /// A `kSec*` constant's string value (class, accessibility, match limit).
    case constant(String)
    /// `SecAccessControlCreateWithFlags(nil, accessibility, flags, …)`.
    case accessControl(KeychainAccessibility, KeychainAccessFlags)
    /// The per-call `LAContext` (`kSecUseAuthenticationContext`).
    case authenticationContext
    /// The secret value (`kSecValueData`), supplied by the caller at execution time.
    case valueData
}

/// A `[String: Any]`-free description of a `SecItem*` query (generic password, data-protection
/// keychain, non-synchronizable). Built by `KeychainQueries`; rendered by the System layer.
public struct KeychainQuery: Equatable, Sendable {
    public enum Operation: String, Sendable {
        case add, read, delete
    }

    public var operation: Operation
    public var service: KeychainService
    public var account: String
    public var accessGroup: String?
    /// Only for `.add`.
    public var protection: KeychainProtection?
    /// `.read`: pass an `LAContext` (prompt text, reuse duration 0, or no-UI).
    public var usesAuthenticationContext: Bool
    public var label: String?

    public init(
        operation: Operation, service: KeychainService, account: String, accessGroup: String? = nil,
        protection: KeychainProtection? = nil, usesAuthenticationContext: Bool = false, label: String? = nil
    ) {
        self.operation = operation
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
        self.protection = protection
        self.usesAuthenticationContext = usesAuthenticationContext
        self.label = label
    }

    /// The query as `kSec*` key → value.
    public var rendered: [String: KeychainQueryValue] {
        var q: [String: KeychainQueryValue] = [
            kSecClass as String: .constant(kSecClassGenericPassword as String),
            kSecAttrService as String: .string(service.rawValue),
            kSecAttrAccount as String: .string(account),
            kSecUseDataProtectionKeychain as String: .bool(true),
            kSecAttrSynchronizable as String: .bool(false),
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = .string(accessGroup) }
        switch operation {
        case .add:
            q[kSecValueData as String] = .valueData
            if let label { q[kSecAttrLabel as String] = .string(label) }
            switch protection {
            case .accessControl(let accessibility, let flags):
                q[kSecAttrAccessControl as String] = .accessControl(accessibility, flags)
            case .accessible(let accessibility):
                q[kSecAttrAccessible as String] = .constant(accessibility.secValue)
            case nil:
                break
            }
        case .read:
            q[kSecReturnData as String] = .bool(true)
            q[kSecMatchLimit as String] = .constant(kSecMatchLimitOne as String)
        case .delete:
            break
        }
        if usesAuthenticationContext { q[kSecUseAuthenticationContext as String] = .authenticationContext }
        return q
    }
}

/// Query builders for each keychain operation Psyche performs.
public enum KeychainQueries {
    // Vault KEKs: created without a prompt, read behind Touch ID / password.
    public static func addVaultKEK(slot: String, accessGroup: String?) -> KeychainQuery {
        KeychainQuery(operation: .add, service: .vault, account: slot, accessGroup: accessGroup, protection: .userPresence, label: "Psyche vault key (\(slot))")
    }

    public static func readVaultKEK(slot: String, accessGroup: String?) -> KeychainQuery {
        KeychainQuery(operation: .read, service: .vault, account: slot, accessGroup: accessGroup, usesAuthenticationContext: true)
    }

    public static func deleteVaultKEK(slot: String, accessGroup: String?) -> KeychainQuery {
        KeychainQuery(operation: .delete, service: .vault, account: slot, accessGroup: accessGroup)
    }

    // Stored items.
    public static func addItem(name: String, requireAuth: Bool, accessGroup: String?) -> KeychainQuery {
        KeychainQuery(
            operation: .add, service: .items, account: name, accessGroup: accessGroup,
            protection: requireAuth ? .userPresence : .accessible(.whenUnlockedThisDeviceOnly), label: "Psyche (\(name))"
        )
    }

    public static func readItem(name: String, accessGroup: String?) -> KeychainQuery {
        KeychainQuery(operation: .read, service: .items, account: name, accessGroup: accessGroup, usesAuthenticationContext: true)
    }

    public static func deleteItem(name: String, accessGroup: String?) -> KeychainQuery {
        KeychainQuery(operation: .delete, service: .items, account: name, accessGroup: accessGroup)
    }

    // Device identity: needed at launch, so no user presence; never leaves this device.
    public static let identityAccount = "device"

    public static func addIdentity(accessGroup: String?) -> KeychainQuery {
        KeychainQuery(
            operation: .add, service: .identity, account: identityAccount, accessGroup: accessGroup,
            protection: .accessible(.afterFirstUnlockThisDeviceOnly), label: "Psyche Helper device identity"
        )
    }

    public static func readIdentity(accessGroup: String?) -> KeychainQuery {
        KeychainQuery(operation: .read, service: .identity, account: identityAccount, accessGroup: accessGroup, usesAuthenticationContext: true)
    }

    public static func deleteIdentity(accessGroup: String?) -> KeychainQuery {
        KeychainQuery(operation: .delete, service: .identity, account: identityAccount, accessGroup: accessGroup)
    }

    /// Deleting an item that is never created: `errSecItemNotFound` means the data-protection
    /// keychain is usable, `errSecMissingEntitlement` means it is not. (A read is not a reliable
    /// probe: unentitled reads of absent items return `errSecItemNotFound` on macOS 27.)
    public static func probe(accessGroup: String?) -> KeychainQuery {
        KeychainQuery(operation: .delete, service: .probe, account: "probe", accessGroup: accessGroup)
    }
}

/// Optional keychain access group: `PSYCHE_KEYCHAIN_GROUP` (dev override), else the Info.plist key
/// `PsycheKeychainAccessGroup` (set by the bundling script to `<TEAMID>.com.psyche.helper`). When
/// absent, the keychain uses the first group of the `keychain-access-groups` entitlement.
public enum KeychainAccessGroup {
    public static let environmentKey = "PSYCHE_KEYCHAIN_GROUP"
    public static let infoPlistKey = "PsycheKeychainAccessGroup"

    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        infoDictionary: [String: Any]? = Bundle.main.infoDictionary
    ) -> String? {
        if let group = normalized(environment[environmentKey]) { return group }
        return normalized(infoDictionary?[infoPlistKey] as? String)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

/// Slot / item name rule: `^[a-z0-9._-]{1,64}$`.
public enum KeychainNames {
    public static let maxLength = 64

    public static func isValid(_ name: String) -> Bool {
        guard (1...maxLength).contains(name.utf8.count) else { return false }
        return name.utf8.allSatisfy { b in
            (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39) || b == 0x2E || b == 0x5F || b == 0x2D
        }
    }

    public static func validate(_ name: String, field: String) throws(CapabilityError) -> String {
        guard isValid(name) else {
            throw CapabilityError.invalidParams("\(field) must match ^[a-z0-9._-]{1,64}$", field: field)
        }
        return name
    }

    /// Touch ID prompt text: 1…120 characters, single line.
    public static let reasonMaxLength = 120

    public static func validateReason(_ reason: String?, required: Bool) throws(CapabilityError) -> String? {
        guard let reason else {
            if required { throw CapabilityError.invalidParams("missing parameter reason", field: "reason") }
            return nil
        }
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= reasonMaxLength, !trimmed.contains(where: \.isNewline) else {
            throw CapabilityError.invalidParams("reason must be 1–\(reasonMaxLength) characters on one line", field: "reason")
        }
        return trimmed
    }
}
