import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheProtocol
import Security

/// Blocking `SecItem*` operations over `KeychainQuery` descriptions. Failures throw
/// `KeychainOSStatusError`. Callers run these off the cooperative pool (see `KeychainVault`).
public protocol KeychainBackend: Sendable {
    func add(_ query: KeychainQuery, value: Data) throws
    /// Reads the item's data. `prompt` is the Touch ID / password prompt text (`LAContext.localizedReason`);
    /// nil means no UI may be shown (`interactionNotAllowed`).
    func copyData(_ query: KeychainQuery, prompt: String?, canceller: AuthenticationCanceller?) throws -> Data
    func delete(_ query: KeychainQuery) throws
    /// Like `copyData`, letting one Touch ID match cover reads for `reuseSeconds` (0–300).
    func copyData(_ query: KeychainQuery, prompt: String?, reuseSeconds: TimeInterval, canceller: AuthenticationCanceller?) throws -> Data
}

extension KeychainBackend {
    public func copyData(_ query: KeychainQuery, prompt: String?, reuseSeconds: TimeInterval, canceller: AuthenticationCanceller?) throws -> Data {
        try copyData(query, prompt: prompt, canceller: canceller)
    }
}

/// Lets an async caller invalidate the `LAContext` of an in-flight read (task cancellation), which
/// dismisses the Touch ID sheet.
public final class AuthenticationCanceller: @unchecked Sendable {
    private let lock = NSLock()
    private var context: LAContext?
    private var cancelled = false

    public init() {}

    func attach(_ context: LAContext) {
        lock.lock()
        let alreadyCancelled = cancelled
        if !alreadyCancelled { self.context = context }
        lock.unlock()
        if alreadyCancelled { context.invalidate() }
    }

    func detach() {
        lock.lock()
        context = nil
        lock.unlock()
    }

    public func cancel() {
        lock.lock()
        cancelled = true
        let ctx = context
        context = nil
        lock.unlock()
        ctx?.invalidate()
    }

    public var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }
}

/// `SecAccessControl` creation (needs no entitlement; the keychain enforces it at use).
public enum KeychainAccessControl {
    public static func make(_ accessibility: KeychainAccessibility, _ flags: KeychainAccessFlags) throws -> SecAccessControl {
        var error: Unmanaged<CFError>?
        guard let acl = SecAccessControlCreateWithFlags(nil, accessibility.secValue as CFString, flags.secFlags, &error) else {
            let code = error.map { CFErrorGetCode($0.takeRetainedValue()) } ?? Int(errSecParam)
            throw KeychainOSStatusError(OSStatus(truncatingIfNeeded: code))
        }
        return acl
    }
}

extension KeychainQuery {
    /// The CF dictionary for `SecItem*`. `value` fills `kSecValueData`; `context` fills
    /// `kSecUseAuthenticationContext` (omitted when nil).
    public func secAttributes(value: Data? = nil, context: LAContext? = nil) throws -> [String: Any] {
        var out: [String: Any] = [:]
        for (key, v) in rendered {
            switch v {
            case .string(let s): out[key] = s
            case .bool(let b): out[key] = b ? kCFBooleanTrue : kCFBooleanFalse
            case .constant(let c): out[key] = c as CFString
            case .accessControl(let accessibility, let flags): out[key] = try KeychainAccessControl.make(accessibility, flags)
            case .authenticationContext: if let context { out[key] = context }
            case .valueData: if let value { out[key] = value }
            }
        }
        return out
    }
}

/// The live backend.
public struct SecItemKeychainBackend: KeychainBackend {
    public init() {}

    public func add(_ query: KeychainQuery, value: Data) throws {
        let attrs = try query.secAttributes(value: value)
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainOSStatusError(status) }
    }

    public func copyData(_ query: KeychainQuery, prompt: String?, canceller: AuthenticationCanceller?) throws -> Data {
        try copyData(query, prompt: prompt, reuseSeconds: 0, canceller: canceller)
    }

    public func copyData(_ query: KeychainQuery, prompt: String?, reuseSeconds: TimeInterval, canceller: AuthenticationCanceller?) throws -> Data {
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = min(LATouchIDAuthenticationMaximumAllowableReuseDuration, max(0, reuseSeconds))
        if let prompt {
            context.localizedReason = prompt
        } else {
            context.interactionNotAllowed = true
        }
        canceller?.attach(context)
        defer {
            canceller?.detach()
            context.invalidate()
        }
        let attrs = try query.secAttributes(context: context)
        var out: CFTypeRef?
        let status = SecItemCopyMatching(attrs as CFDictionary, &out)
        guard status == errSecSuccess else { throw KeychainOSStatusError(status) }
        guard let data = out as? Data else { throw KeychainOSStatusError(errSecInternalError) }
        return data
    }

    public func delete(_ query: KeychainQuery) throws {
        let attrs = try query.secAttributes()
        let status = SecItemDelete(attrs as CFDictionary)
        guard status == errSecSuccess else { throw KeychainOSStatusError(status) }
    }
}

/// Touch ID / password availability (`keychain.status`).
public struct BiometryStatus: Sendable, Equatable {
    public var available: Bool
    /// `touch_id`, `face_id`, `optic_id`, or `none`.
    public var type: String
    /// Why biometry cannot be used: `not_enrolled`, `lockout`, `not_available`, `passcode_not_set`, …
    public var unavailableReason: String?
    /// Whether the device-passcode (login password) fallback is usable.
    public var devicePasscode: Bool

    public init(available: Bool, type: String, unavailableReason: String? = nil, devicePasscode: Bool) {
        self.available = available
        self.type = type
        self.unavailableReason = unavailableReason
        self.devicePasscode = devicePasscode
    }

    /// Asks `LAContext.canEvaluatePolicy` (never prompts).
    public static func current() -> BiometryStatus {
        let context = LAContext()
        var bioError: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &bioError)
        let type: String
        switch context.biometryType {
        case .touchID: type = "touch_id"
        case .faceID: type = "face_id"
        case .opticID: type = "optic_id"
        default: type = "none"
        }
        var ownerError: NSError?
        let passcode = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &ownerError)
        return BiometryStatus(available: available, type: type, unavailableReason: bioError.map { reason(laCode: $0.code) }, devicePasscode: passcode)
    }

    static func reason(laCode: Int) -> String {
        switch laCode {
        case LAError.Code.biometryNotEnrolled.rawValue: "not_enrolled"
        case LAError.Code.biometryLockout.rawValue: "lockout"
        case LAError.Code.biometryNotAvailable.rawValue: "not_available"
        case LAError.Code.passcodeNotSet.rawValue: "passcode_not_set"
        case LAError.Code.biometryNotPaired.rawValue: "not_paired"
        case LAError.Code.biometryDisconnected.rawValue: "disconnected"
        default: "error_\(abs(laCode))"
        }
    }

    public var json: JSONValue {
        [
            "available": .bool(available),
            "type": .string(type),
            "unavailableReason": unavailableReason.map { .string($0) } ?? .null,
            "devicePasscode": .bool(devicePasscode),
        ]
    }
}
