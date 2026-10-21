import Foundation
import PsycheProtocol
import Security

/// A failed `SecItem*` call. Thrown by keychain backends; mapped to a `CapabilityError` at the edge.
public struct KeychainOSStatusError: Error, Equatable, Sendable, CustomStringConvertible {
    public var status: OSStatus

    public init(_ status: OSStatus) { self.status = status }

    public var isMissingEntitlement: Bool { status == errSecMissingEntitlement }
    public var isNotFound: Bool { status == errSecItemNotFound }
    public var isDuplicate: Bool { status == errSecDuplicateItem }

    public var description: String { "OSStatus \(status)" }
    public var capabilityError: CapabilityError { KeychainStatus.error(osStatus: status) }
}

/// OSStatus / LAError → `CapabilityError` (security §4.2, §12). Numeric values are checked against
/// the macOS SDK headers (Security/SecBase.h, LocalAuthentication/LAPublicDefines.h) in tests.
public enum KeychainStatus {
    /// `LAError.Code` raw values (LocalAuthentication is not linked from Core).
    public enum LACode {
        public static let authenticationFailed = -1
        public static let userCancel = -2
        public static let userFallback = -3
        public static let systemCancel = -4
        public static let passcodeNotSet = -5
        public static let biometryNotAvailable = -6
        public static let biometryNotEnrolled = -7
        public static let biometryLockout = -8
        public static let appCancel = -9
        public static let invalidContext = -10
        public static let notInteractive = -1004
    }

    public static let laErrorDomain = "com.apple.LocalAuthentication"

    public static let missingEntitlementMessage =
        "The data-protection keychain is unavailable: this Psyche (Helper) build has no keychain access group entitlement "
        + "(errSecMissingEntitlement, -34018). keychain-access-groups is a restricted entitlement, so the helper must be "
        + "signed with an embedded provisioning profile that grants a team-prefixed keychain access group."

    public static func error(osStatus status: OSStatus) -> CapabilityError {
        switch status {
        case errSecMissingEntitlement:
            return CapabilityError(.unavailable, reason: "missing_entitlement", missingEntitlementMessage, details: ["status": .int(Int(status))])
        case errSecItemNotFound:
            return CapabilityError(.notFound, reason: "item_not_found", "No keychain item with that name")
        case errSecUserCanceled:
            return userCancelled
        case errSecAuthFailed:
            return CapabilityError(.forbidden, reason: "auth_failed", "Authentication failed")
        case errSecParam:
            return CapabilityError(.errorCodeInternal, reason: "keychain_param", "The keychain rejected the query parameters (errSecParam, -50)", details: ["status": .int(Int(status))])
        case errSecDuplicateItem:
            return CapabilityError(.conflict, reason: "duplicate_item", "A keychain item with that name already exists")
        case errSecInteractionNotAllowed:
            return CapabilityError(
                .unavailable, reason: "interaction_not_allowed",
                "The keychain needs user interaction that is not possible now (the Mac is locked or no UI session)",
                retryable: true
            )
        case errSecNotAvailable:
            return CapabilityError(.unavailable, reason: "keychain_unavailable", "No keychain is available", details: ["status": .int(Int(status))])
        default:
            return CapabilityError(.errorCodeInternal, reason: "keychain_error", "Keychain error \(status)", details: ["status": .int(Int(status))])
        }
    }

    /// `LAError.Code` raw value → `CapabilityError`.
    public static func error(laCode code: Int) -> CapabilityError {
        switch code {
        case LACode.userCancel, LACode.systemCancel, LACode.appCancel, LACode.userFallback:
            return userCancelled
        case LACode.biometryLockout:
            return CapabilityError(
                .forbidden, reason: "biometry_lockout",
                "Touch ID is locked after too many failed attempts; unlock the Mac with its password first"
            )
        case LACode.authenticationFailed:
            return CapabilityError(.forbidden, reason: "auth_failed", "Authentication failed")
        case LACode.passcodeNotSet:
            return CapabilityError(.unavailable, reason: "passcode_not_set", "This Mac has no login password set")
        case LACode.notInteractive:
            return CapabilityError(
                .unavailable, reason: "interaction_not_allowed", "Authentication UI cannot be shown now", retryable: true
            )
        default:
            return CapabilityError(.errorCodeInternal, reason: "keychain_error", "Authentication error \(code)", details: ["laError": .int(code)])
        }
    }

    /// Any error from the keychain layer → `CapabilityError`.
    public static func error(from error: any Error) -> CapabilityError {
        switch error {
        case let e as CapabilityError: return e
        case let e as KeychainOSStatusError: return e.capabilityError
        case let e as KeyWrapError: return e.capabilityError
        default:
            let ns = error as NSError
            if ns.domain == laErrorDomain { return self.error(laCode: ns.code) }
            if ns.domain == NSOSStatusErrorDomain { return self.error(osStatus: OSStatus(truncatingIfNeeded: ns.code)) }
            return CapabilityError(.errorCodeInternal, reason: "keychain_error", "Keychain error")
        }
    }

    static let userCancelled = CapabilityError(.cancelled, reason: "user_cancelled", "The user cancelled authentication")
}
