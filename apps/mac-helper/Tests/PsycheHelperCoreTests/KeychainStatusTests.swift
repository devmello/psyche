import Foundation
import PsycheHelperCore
import PsycheProtocol
import Security
import Testing

@Suite("Keychain OSStatus / LAError mapping")
struct KeychainStatusTests {
    /// Numeric values as declared in the macOS SDK (Security/SecBase.h).
    @Test func sdkConstantsHaveTheDocumentedValues() {
        #expect(errSecMissingEntitlement == -34018)
        #expect(errSecItemNotFound == -25300)
        #expect(errSecUserCanceled == -128)
        #expect(errSecAuthFailed == -25293)
        #expect(errSecParam == -50)
        #expect(errSecDuplicateItem == -25299)
        #expect(errSecInteractionNotAllowed == -25308)
        #expect(errSecNotAvailable == -25291)
    }

    struct Row: Sendable, CustomStringConvertible {
        var status: OSStatus
        var code: ErrorCode
        var reason: String
        var description: String { "\(status) → \(code.rawValue)/\(reason)" }
    }

    static let table: [Row] = [
        Row(status: -34018, code: .unavailable, reason: "missing_entitlement"),
        Row(status: -25300, code: .notFound, reason: "item_not_found"),
        Row(status: -128, code: .cancelled, reason: "user_cancelled"),
        Row(status: -25293, code: .forbidden, reason: "auth_failed"),
        Row(status: -50, code: .errorCodeInternal, reason: "keychain_param"),
        Row(status: -25299, code: .conflict, reason: "duplicate_item"),
        Row(status: -25308, code: .unavailable, reason: "interaction_not_allowed"),
        Row(status: -25291, code: .unavailable, reason: "keychain_unavailable"),
        Row(status: -26276, code: .errorCodeInternal, reason: "keychain_error"),
        Row(status: 12345, code: .errorCodeInternal, reason: "keychain_error"),
    ]

    @Test(arguments: table)
    func mapsOSStatus(_ row: Row) {
        let e = KeychainStatus.error(osStatus: row.status)
        #expect(e.code == row.code)
        #expect(e.reason == row.reason)
        #expect(e.wire.details?["reason"] == .string(row.reason))
    }

    @Test func unknownStatusCarriesTheNumber() {
        #expect(KeychainStatus.error(osStatus: -26276).details["status"] == .int(-26276))
    }

    @Test func missingEntitlementExplainsTheProvisioningProfile() {
        let e = KeychainStatus.error(osStatus: errSecMissingEntitlement)
        #expect(e.message.contains("provisioning profile"))
        #expect(e.message.contains("keychain access group"))
        #expect(e.details["status"] == .int(-34018))
    }

    @Test func interactionNotAllowedIsRetryable() {
        #expect(KeychainStatus.error(osStatus: errSecInteractionNotAllowed).retryable)
    }

    @Test(arguments: [
        (-2, ErrorCode.cancelled, "user_cancelled"), // userCancel
        (-4, ErrorCode.cancelled, "user_cancelled"), // systemCancel
        (-9, ErrorCode.cancelled, "user_cancelled"), // appCancel
        (-8, ErrorCode.forbidden, "biometry_lockout"), // biometryLockout
        (-1, ErrorCode.forbidden, "auth_failed"), // authenticationFailed
        (-5, ErrorCode.unavailable, "passcode_not_set"),
        (-1004, ErrorCode.unavailable, "interaction_not_allowed"), // notInteractive
        (-6, ErrorCode.errorCodeInternal, "keychain_error"),
    ])
    func mapsLAErrorCodes(code: Int, expected: ErrorCode, reason: String) {
        let e = KeychainStatus.error(laCode: code)
        #expect(e.code == expected)
        #expect(e.reason == reason)
    }

    @Test func mapsErrorsByDomain() {
        let la = NSError(domain: "com.apple.LocalAuthentication", code: -2)
        #expect(KeychainStatus.error(from: la).reason == "user_cancelled")
        let os = NSError(domain: NSOSStatusErrorDomain, code: -34018)
        #expect(KeychainStatus.error(from: os).reason == "missing_entitlement")
        #expect(KeychainStatus.error(from: KeychainOSStatusError(-25299)).reason == "duplicate_item")
        #expect(KeychainStatus.error(from: KeyWrapError.authenticationFailed).reason == "unwrap_failed")
        let passthrough = CapabilityError.invalidParams("x")
        #expect(KeychainStatus.error(from: passthrough) == passthrough)
    }
}
