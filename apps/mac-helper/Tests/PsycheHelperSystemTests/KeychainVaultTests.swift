import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Security
import Testing

/// In-memory keychain: items keyed by service/account; optionally fails every call with one status.
final class FakeKeychainBackend: KeychainBackend, @unchecked Sendable {
    struct Key: Hashable {
        var service: String
        var account: String
    }

    struct Item {
        var value: Data
        var protection: KeychainProtection?
    }

    private let lock = NSLock()
    private var items: [Key: Item] = [:]
    /// Status every mutating call fails with (e.g. -34018); reads of absent items still report
    /// -25300, as unentitled reads do on macOS 27.
    var failMutationsWith: OSStatus?
    /// Status reads of present items fail with (e.g. -128 for a cancelled prompt).
    var failReadsWith: OSStatus?
    private(set) var prompts: [String?] = []

    func snapshot() -> [Key: Item] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    private func key(_ q: KeychainQuery) -> Key { Key(service: q.service.rawValue, account: q.account) }

    func add(_ query: KeychainQuery, value: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        precondition(query.operation == .add)
        if let s = failMutationsWith { throw KeychainOSStatusError(s) }
        if items[key(query)] != nil { throw KeychainOSStatusError(errSecDuplicateItem) }
        items[key(query)] = Item(value: value, protection: query.protection)
    }

    func copyData(_ query: KeychainQuery, prompt: String?, canceller: AuthenticationCanceller?) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        precondition(query.operation == .read)
        prompts.append(prompt)
        guard let item = items[key(query)] else { throw KeychainOSStatusError(errSecItemNotFound) }
        if let s = failReadsWith { throw KeychainOSStatusError(s) }
        return item.value
    }

    func delete(_ query: KeychainQuery) throws {
        lock.lock()
        defer { lock.unlock() }
        precondition(query.operation == .delete)
        if let s = failMutationsWith { throw KeychainOSStatusError(s) }
        guard items.removeValue(forKey: key(query)) != nil else { throw KeychainOSStatusError(errSecItemNotFound) }
    }
}

let fakeBiometry: @Sendable () -> BiometryStatus = { BiometryStatus(available: true, type: "touch_id", devicePasscode: true) }

func expectCapabilityError(_ code: ErrorCode, _ reason: String, sourceLocation: SourceLocation = #_sourceLocation, _ body: () async throws -> Void) async {
    do {
        try await body()
        Issue.record("expected \(code.rawValue)/\(reason), got success", sourceLocation: sourceLocation)
    } catch let e as CapabilityError {
        #expect(e.code == code, sourceLocation: sourceLocation)
        #expect(e.reason == reason, sourceLocation: sourceLocation)
    } catch {
        Issue.record("expected CapabilityError, got \(error)", sourceLocation: sourceLocation)
    }
}

@Suite("KeychainVault over a fake backend")
struct KeychainVaultTests {
    let backend = FakeKeychainBackend()
    var vault: KeychainVault { KeychainVault(backend: backend, accessGroup: nil, biometry: fakeBiometry) }
    let dek = Data((0..<32).map { UInt8(255 - $0) })

    @Test func wrapThenUnwrapRoundTrips() async throws {
        let out = try await vault.wrapKey(slot: "vault.main", dek: dek)
        #expect(!out.replaced)
        let items = backend.snapshot()
        let item = try #require(items[.init(service: "com.psyche.vault", account: "vault.main")])
        #expect(item.value.count == 32)
        #expect(item.value != dek)
        #expect(item.protection == .accessControl(.whenPasscodeSetThisDeviceOnly, [.biometryCurrentSet, .or, .devicePasscode]))
        #expect(backend.prompts.isEmpty) // creation never reads (no Touch ID)

        let back = try await vault.unwrapKey(slot: "vault.main", wrapped: out.wrapped, reason: "unlock your Psyche vault")
        #expect(back == dek)
        #expect(backend.prompts == ["unlock your Psyche vault"])
    }

    @Test func existingSlotConflictsUnlessReplaced() async throws {
        let first = try await vault.wrapKey(slot: "s", dek: dek)
        await expectCapabilityError(.conflict, "duplicate_item") { _ = try await vault.wrapKey(slot: "s", dek: dek) }
        let second = try await vault.wrapKey(slot: "s", dek: dek, replace: true)
        #expect(second.replaced)
        // The old blob no longer opens: its KEK is gone.
        await expectCapabilityError(.invalidParams, "unwrap_failed") {
            _ = try await vault.unwrapKey(slot: "s", wrapped: first.wrapped, reason: "r")
        }
        #expect(try await vault.unwrapKey(slot: "s", wrapped: second.wrapped, reason: "r") == dek)
    }

    @Test func blobsAreBoundToTheirSlot() async throws {
        let a = try await vault.wrapKey(slot: "a", dek: dek)
        _ = try await vault.wrapKey(slot: "b", dek: dek)
        await expectCapabilityError(.invalidParams, "unwrap_failed") { _ = try await vault.unwrapKey(slot: "b", wrapped: a.wrapped, reason: "r") }
    }

    @Test func malformedBlobsFailBeforeAnyPrompt() async throws {
        _ = try await vault.wrapKey(slot: "s", dek: dek)
        await expectCapabilityError(.invalidParams, "wrapped_malformed") { _ = try await vault.unwrapKey(slot: "s", wrapped: "AQAA", reason: "r") }
        await expectCapabilityError(.invalidParams, "wrapped_malformed") { _ = try await vault.unwrapKey(slot: "s", wrapped: "%%%", reason: "r") }
        await expectCapabilityError(.invalidParams, "wrapped_version") {
            _ = try await vault.unwrapKey(slot: "s", wrapped: Base64URL.encode(Data([2] + [UInt8](repeating: 0, count: 60))), reason: "r")
        }
        #expect(backend.prompts.isEmpty)
    }

    @Test func rejectsBadDEKSizesAndSlotNames() async {
        await expectCapabilityError(.invalidParams, "bad_key_size") { _ = try await vault.wrapKey(slot: "s", dek: Data(count: 16)) }
        await expectCapabilityError(.invalidParams, "invalid_params") { _ = try await vault.wrapKey(slot: "Bad Slot", dek: dek) }
        #expect(backend.snapshot().isEmpty)
    }

    @Test func unwrapOfAMissingSlotIsNotFound() async throws {
        let wrapped = try KeyWrap.wrapBase64URL(dek: dek, kek: KeyWrap.generateKEK(), slot: "gone")
        await expectCapabilityError(.notFound, "item_not_found") { _ = try await vault.unwrapKey(slot: "gone", wrapped: wrapped, reason: "r") }
    }

    @Test func cancelledPromptMapsToUserCancelled() async throws {
        let out = try await vault.wrapKey(slot: "s", dek: dek)
        backend.failReadsWith = errSecUserCanceled
        await expectCapabilityError(.cancelled, "user_cancelled") { _ = try await vault.unwrapKey(slot: "s", wrapped: out.wrapped, reason: "r") }
        backend.failReadsWith = errSecAuthFailed
        await expectCapabilityError(.forbidden, "auth_failed") { _ = try await vault.unwrapKey(slot: "s", wrapped: out.wrapped, reason: "r") }
    }

    @Test func missingEntitlementFailsEveryOperationCleanly() async throws {
        backend.failMutationsWith = errSecMissingEntitlement
        await expectCapabilityError(.unavailable, "missing_entitlement") { _ = try await vault.wrapKey(slot: "s", dek: dek) }
        await expectCapabilityError(.unavailable, "missing_entitlement") { _ = try await vault.store(name: "n", value: Data([1])) }
        await expectCapabilityError(.unavailable, "missing_entitlement") { try await vault.delete(.slot("s")) }
        // Reads of absent items report not-found when unentitled; the vault probes and says why.
        let wrapped = try KeyWrap.wrapBase64URL(dek: dek, kek: KeyWrap.generateKEK(), slot: "s")
        await expectCapabilityError(.unavailable, "missing_entitlement") { _ = try await vault.unwrapKey(slot: "s", wrapped: wrapped, reason: "r") }
        await expectCapabilityError(.unavailable, "missing_entitlement") { _ = try await vault.retrieve(name: "n", reason: "r") }
        let status = await vault.status()
        #expect(status.dataProtection == .missingEntitlement)
        #expect(status.probeStatus == errSecMissingEntitlement)
    }

    @Test func storeRetrieveDelete() async throws {
        let value = Data("token-value".utf8)
        #expect(try await vault.store(name: "github.token", value: value) == false)
        await expectCapabilityError(.conflict, "duplicate_item") { _ = try await vault.store(name: "github.token", value: value) }
        #expect(try await vault.store(name: "github.token", value: Data("v2".utf8), requireAuth: false, replace: true) == true)
        let item = try #require(backend.snapshot()[.init(service: "com.psyche.helper.items", account: "github.token")])
        #expect(item.protection == .accessible(.whenUnlockedThisDeviceOnly))
        #expect(try await vault.retrieve(name: "github.token", reason: "read the token") == Data("v2".utf8))
        try await vault.delete(.item("github.token"))
        await expectCapabilityError(.notFound, "item_not_found") { try await vault.delete(.item("github.token")) }
        await expectCapabilityError(.notFound, "item_not_found") { _ = try await vault.retrieve(name: "github.token", reason: "r") }
    }

    @Test func storeEnforcesSizeLimits() async {
        await expectCapabilityError(.invalidParams, "invalid_params") { _ = try await vault.store(name: "n", value: Data()) }
        await expectCapabilityError(.invalidParams, "invalid_params") { _ = try await vault.store(name: "n", value: Data(count: KeychainVault.maxItemBytes + 1)) }
    }

    @Test func statusReportsAvailableWhenTheProbeIsNotFound() async {
        let status = await vault.status()
        #expect(status.dataProtection == .available)
        #expect(status.probeStatus == nil)
        #expect(status.json["dataProtectionKeychain"] == "available")
        #expect(status.json["biometry"]?["type"] == "touch_id")
        #expect(backend.snapshot().isEmpty)
    }
}

@Suite("SecAccessControl and live query rendering")
struct KeychainAccessControlTests {
    @Test func biometryOrPasscodeAccessControlCreatesWithoutEntitlement() throws {
        _ = try KeychainAccessControl.make(.whenPasscodeSetThisDeviceOnly, [.biometryCurrentSet, .or, .devicePasscode])
    }

    /// Two logical operators at once are rejected with errSecParam at creation (deterministic).
    /// Leaving `.or` out is not an error at creation: the constraints are ANDed instead, so the
    /// builders always include `.or` (covered in KeychainQueryTests).
    @Test func conflictingOperatorsAreErrSecParam() {
        #expect(throws: KeychainOSStatusError(errSecParam)) {
            try KeychainAccessControl.make(.whenPasscodeSetThisDeviceOnly, [.biometryCurrentSet, .or, .and, .devicePasscode])
        }
    }

    @Test func rendersCFObjects() throws {
        let add = try KeychainQueries.addVaultKEK(slot: "s", accessGroup: "T.group").secAttributes(value: Data([1, 2]))
        #expect(CFGetTypeID(add[kSecAttrAccessControl as String] as CFTypeRef) == SecAccessControlGetTypeID())
        #expect(add[kSecAttrAccessible as String] == nil)
        #expect(add[kSecValueData as String] as? Data == Data([1, 2]))
        #expect(add[kSecUseDataProtectionKeychain as String] as? Bool == true)
        #expect(add[kSecAttrSynchronizable as String] as? Bool == false)
        #expect(add[kSecAttrAccessGroup as String] as? String == "T.group")

        let context = LAContext()
        let read = try KeychainQueries.readVaultKEK(slot: "s", accessGroup: nil).secAttributes(context: context)
        #expect(read[kSecUseAuthenticationContext as String] as? LAContext === context)
        #expect(read[kSecReturnData as String] as? Bool == true)
        let noContext = try KeychainQueries.readVaultKEK(slot: "s", accessGroup: nil).secAttributes()
        #expect(noContext[kSecUseAuthenticationContext as String] == nil)
    }

    @Test func laErrorCodesMatchTheFramework() {
        #expect(KeychainStatus.LACode.userCancel == LAError.Code.userCancel.rawValue)
        #expect(KeychainStatus.LACode.systemCancel == LAError.Code.systemCancel.rawValue)
        #expect(KeychainStatus.LACode.appCancel == LAError.Code.appCancel.rawValue)
        #expect(KeychainStatus.LACode.biometryLockout == LAError.Code.biometryLockout.rawValue)
        #expect(KeychainStatus.LACode.authenticationFailed == LAError.Code.authenticationFailed.rawValue)
        #expect(KeychainStatus.LACode.passcodeNotSet == LAError.Code.passcodeNotSet.rawValue)
        #expect(KeychainStatus.LACode.notInteractive == LAError.Code.notInteractive.rawValue)
        #expect(KeychainStatus.laErrorDomain == LAErrorDomain)
    }
}
