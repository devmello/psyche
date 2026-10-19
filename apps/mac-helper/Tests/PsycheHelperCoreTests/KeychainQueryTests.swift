import Foundation
import PsycheHelperCore
import Security
import Testing

@Suite("Keychain query shapes")
struct KeychainQueryTests {
    static let accessible = kSecAttrAccessible as String
    static let accessControl = kSecAttrAccessControl as String

    static let allQueries: [KeychainQuery] = [
        KeychainQueries.addVaultKEK(slot: "vault.main", accessGroup: nil),
        KeychainQueries.readVaultKEK(slot: "vault.main", accessGroup: nil),
        KeychainQueries.deleteVaultKEK(slot: "vault.main", accessGroup: nil),
        KeychainQueries.addItem(name: "n", requireAuth: true, accessGroup: nil),
        KeychainQueries.addItem(name: "n", requireAuth: false, accessGroup: nil),
        KeychainQueries.readItem(name: "n", accessGroup: nil),
        KeychainQueries.deleteItem(name: "n", accessGroup: nil),
        KeychainQueries.addIdentity(accessGroup: nil),
        KeychainQueries.readIdentity(accessGroup: nil),
        KeychainQueries.deleteIdentity(accessGroup: nil),
        KeychainQueries.probe(accessGroup: nil),
    ]

    @Test func everyQueryTargetsTheDataProtectionKeychainAndNeverSyncs() {
        for q in Self.allQueries {
            let r = q.rendered
            #expect(r[kSecUseDataProtectionKeychain as String] == .bool(true), "\(q.operation) \(q.service)")
            #expect(r[kSecAttrSynchronizable as String] == .bool(false))
            #expect(r[kSecClass as String] == .constant(kSecClassGenericPassword as String))
            #expect(r[kSecAttrService as String] == .string(q.service.rawValue))
            #expect(r[kSecAttrAccount as String] == .string(q.account))
            #expect(r[kSecAttrAccessGroup as String] == nil)
        }
    }

    @Test func neverCombinesAccessibleWithAccessControl() {
        for q in Self.allQueries {
            let r = q.rendered
            #expect(!(r[Self.accessible] != nil && r[Self.accessControl] != nil), "\(q.operation) \(q.service)")
        }
    }

    @Test func vaultKEKUsesBiometryOrPasscodeWhenPasscodeSet() {
        let r = KeychainQueries.addVaultKEK(slot: "vault.main", accessGroup: nil).rendered
        #expect(r[Self.accessControl] == .accessControl(.whenPasscodeSetThisDeviceOnly, [.biometryCurrentSet, .or, .devicePasscode]))
        #expect(r[Self.accessible] == nil)
        #expect(r[kSecValueData as String] == .valueData)
        #expect(r[kSecAttrService as String] == .string("com.psyche.vault"))
        #expect(r[kSecAttrAccount as String] == .string("vault.main"))
        #expect(r[kSecUseAuthenticationContext as String] == nil) // creation never prompts
    }

    @Test func biometryOrPasscodeIncludesTheOrOperator() {
        let flags = KeychainAccessFlags.biometryOrPasscode
        #expect(flags.contains(.or))
        #expect(!flags.contains(.and))
        #expect(flags.secFlags == [.biometryCurrentSet, .or, .devicePasscode])
    }

    @Test func readsReturnOneItemThroughAnAuthenticationContext() {
        for q in [KeychainQueries.readVaultKEK(slot: "s", accessGroup: nil), KeychainQueries.readItem(name: "n", accessGroup: nil)] {
            let r = q.rendered
            #expect(r[kSecReturnData as String] == .bool(true))
            #expect(r[kSecMatchLimit as String] == .constant(kSecMatchLimitOne as String))
            #expect(r[kSecUseAuthenticationContext as String] == .authenticationContext)
            #expect(r[kSecValueData as String] == nil)
            #expect(r[Self.accessControl] == nil && r[Self.accessible] == nil)
        }
    }

    @Test func itemsWithoutAuthUseWhenUnlockedThisDeviceOnly() {
        let r = KeychainQueries.addItem(name: "n", requireAuth: false, accessGroup: nil).rendered
        #expect(r[Self.accessible] == .constant(kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String))
        #expect(r[Self.accessControl] == nil)
        #expect(r[kSecAttrService as String] == .string("com.psyche.helper.items"))
        let auth = KeychainQueries.addItem(name: "n", requireAuth: true, accessGroup: nil).rendered
        #expect(auth[Self.accessControl] == .accessControl(.whenPasscodeSetThisDeviceOnly, .biometryOrPasscode))
    }

    @Test func identityHasNoUserPresence() {
        let r = KeychainQueries.addIdentity(accessGroup: nil).rendered
        #expect(r[kSecAttrService as String] == .string("com.psyche.helper.identity"))
        #expect(r[Self.accessible] == .constant(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String))
        #expect(r[Self.accessControl] == nil)
    }

    @Test func deletesCarryOnlyMatchAttributes() {
        let r = KeychainQueries.deleteVaultKEK(slot: "s", accessGroup: nil).rendered
        #expect(Set(r.keys) == [
            kSecClass as String, kSecAttrService as String, kSecAttrAccount as String,
            kSecUseDataProtectionKeychain as String, kSecAttrSynchronizable as String,
        ])
    }

    @Test func accessGroupIsOptional() {
        let group = "ABCDE12345.com.psyche.helper"
        for q in [
            KeychainQueries.addVaultKEK(slot: "s", accessGroup: group), KeychainQueries.readItem(name: "n", accessGroup: group),
            KeychainQueries.addIdentity(accessGroup: group), KeychainQueries.probe(accessGroup: group),
        ] {
            #expect(q.rendered[kSecAttrAccessGroup as String] == .string(group))
        }
    }

    @Test func secConstantsHaveExpectedValues() {
        #expect(KeychainAccessibility.whenPasscodeSetThisDeviceOnly.secValue == "akpu")
        #expect(KeychainAccessibility.afterFirstUnlockThisDeviceOnly.secValue == "cku")
        #expect(KeychainAccessibility.whenUnlockedThisDeviceOnly.secValue == "aku")
    }

    // MARK: - Access group resolution

    @Test func accessGroupComesFromTheEnvironmentThenInfoPlist() {
        #expect(KeychainAccessGroup.resolve(environment: [:], infoDictionary: nil) == nil)
        #expect(KeychainAccessGroup.resolve(environment: [:], infoDictionary: ["PsycheKeychainAccessGroup": "T.plist"]) == "T.plist")
        #expect(KeychainAccessGroup.resolve(environment: ["PSYCHE_KEYCHAIN_GROUP": "T.env"], infoDictionary: ["PsycheKeychainAccessGroup": "T.plist"]) == "T.env")
        #expect(KeychainAccessGroup.resolve(environment: ["PSYCHE_KEYCHAIN_GROUP": "  "], infoDictionary: ["PsycheKeychainAccessGroup": " T.plist\n"]) == "T.plist")
        #expect(KeychainAccessGroup.resolve(environment: [:], infoDictionary: ["PsycheKeychainAccessGroup": ""]) == nil)
    }

    // MARK: - Names and reasons

    @Test(arguments: ["a", "vault.main", "vault-1_x", "0", String(repeating: "a", count: 64)])
    func acceptsValidNames(_ name: String) {
        #expect(KeychainNames.isValid(name))
    }

    @Test(arguments: ["", "Vault", "a b", "a/b", "é", String(repeating: "a", count: 65), "a\n", "*"])
    func rejectsInvalidNames(_ name: String) {
        #expect(!KeychainNames.isValid(name))
        #expect(throws: CapabilityError.self) { try KeychainNames.validate(name, field: "slot") }
    }

    @Test func validatesReasons() throws {
        #expect(try KeychainNames.validateReason(nil, required: false) == nil)
        #expect(throws: CapabilityError.self) { try KeychainNames.validateReason(nil, required: true) }
        #expect(throws: CapabilityError.self) { try KeychainNames.validateReason("   ", required: true) }
        #expect(throws: CapabilityError.self) { try KeychainNames.validateReason("two\nlines", required: true) }
        #expect(throws: CapabilityError.self) { try KeychainNames.validateReason(String(repeating: "x", count: 121), required: true) }
        #expect(try KeychainNames.validateReason(" unlock your Psyche vault ", required: true) == "unlock your Psyche vault")
        #expect(try KeychainNames.validateReason(String(repeating: "x", count: 120), required: true)?.count == 120)
    }
}
