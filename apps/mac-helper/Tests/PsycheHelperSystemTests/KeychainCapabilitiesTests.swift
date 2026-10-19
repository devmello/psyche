import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Security
import Testing

@Suite("keychain.* capabilities")
struct KeychainCapabilitiesTests {
    let backend = FakeKeychainBackend()
    var registry: CapabilityRegistry {
        CapabilityRegistry(KeychainCapabilities.make(vault: KeychainVault(backend: backend, accessGroup: nil, biometry: fakeBiometry)))
    }

    func invoke(_ name: String, _ params: JSONValue) async throws -> CapabilityOutput {
        let handler = try #require(registry[name])
        let ctx = InvocationContext(invocationId: "inv_1", capability: name, params: params, approvalId: nil, emit: { _ in })
        return try await handler.invoke(ctx)
    }

    static let setParams: JSONValue = [
        "service": "com.psyche.vault", "account": "01JABCDEF", "value": .string(Data(repeating: 7, count: 32).base64EncodedString()),
        "accessControl": ["biometryCurrentSet", "or", "devicePasscode"], "accessible": "whenPasscodeSetThisDeviceOnly",
        "synchronizable": false, "dataProtection": true,
    ]

    @Test func declaresS06sContract() {
        let specs = Dictionary(uniqueKeysWithValues: registry.ordered.map { ($0.spec.name, $0.spec) })
        #expect(Set(specs.keys) == ["keychain.set", "vault.unlock", "keychain.delete", "keychain.status"])
        #expect(specs["keychain.set"]?.sideEffect == .write && specs["keychain.set"]?.receiptKind == "vault_key")
        #expect(specs["vault.unlock"]?.sideEffect == .read && specs["vault.unlock"]?.description.contains("secret") == true)
        #expect(specs["keychain.delete"]?.sideEffect == .destructive)
        #expect(specs["vault.unlock"]?.inputSchema["required"] == ["account", "reason", "service"])
    }

    @Test func setThenUnlockRoundTripsTheKey() async throws {
        let set = try await invoke("keychain.set", Self.setParams)
        #expect(set.result == [:] && set.receipt?.outcome == .ok)
        let item = try #require(backend.snapshot()[.init(service: "com.psyche.vault", account: "01JABCDEF")])
        #expect(item.protection == .accessControl(.whenPasscodeSetThisDeviceOnly, [.biometryCurrentSet, .or, .devicePasscode]))
        let out = try await invoke("vault.unlock", ["service": "com.psyche.vault", "account": "01JABCDEF", "reason": "unlock your Psyche vault",
                                                    "reuseDurationSeconds": 0])
        #expect(out.result["value"] == .string(Data(repeating: 7, count: 32).base64EncodedString()))
        #expect(backend.prompts.last == "unlock your Psyche vault")
        // Setting again replaces (vault creation and rekey).
        _ = try await invoke("keychain.set", Self.setParams)
        _ = try await invoke("keychain.delete", ["service": "com.psyche.vault", "account": "01JABCDEF"])
        #expect(backend.snapshot().isEmpty)
    }

    @Test func refusesWeakerProtectionOrOtherServices() async {
        func expectInvalid(_ name: String, _ params: JSONValue) async {
            do {
                _ = try await invoke(name, params)
                Issue.record("\(name) accepted \(params)")
            } catch let e as CapabilityError {
                #expect(e.code == .invalidParams)
            } catch { Issue.record("unexpected \(error)") }
        }
        var weak = Self.setParams.objectValue!
        weak["accessControl"] = ["biometryCurrentSet", "devicePasscode"]
        await expectInvalid("keychain.set", .object(weak))
        var sync = Self.setParams.objectValue!
        sync["synchronizable"] = true
        await expectInvalid("keychain.set", .object(sync))
        var other = Self.setParams.objectValue!
        other["service"] = "com.example.other"
        await expectInvalid("keychain.set", .object(other))
        await expectInvalid("vault.unlock", ["service": "com.psyche.vault", "account": "a/b", "reason": "x"])
        await expectInvalid("vault.unlock", ["service": "com.psyche.vault", "account": "a", "reason": ""])
    }

    @Test func missingEntitlementIsUnavailable() async {
        backend.failMutationsWith = -34018
        do {
            _ = try await invoke("keychain.set", Self.setParams)
            Issue.record("expected missing_entitlement")
        } catch let e as CapabilityError {
            #expect(e.code == .unavailable && e.reason == "missing_entitlement")
        } catch { Issue.record("unexpected \(error)") }
    }

    @Test func statusCapability() async throws {
        let out = try await invoke("keychain.status", [:])
        #expect(out.result["dataProtectionKeychain"] == "available")
        #expect(out.result["biometry"]?["available"] == true)
    }
}

@Suite("Device identity store resolution")
struct KeychainIdentityResolutionTests {
    final class Lines: @unchecked Sendable {
        private let lock = NSLock()
        private var lines: [String] = []
        func append(_ s: String) { lock.lock(); lines.append(s); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return lines }
    }

    static func tempFileStore() -> FileDeviceIdentityStore {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("psyche-resolve-\(UUID().uuidString)")
        return FileDeviceIdentityStore(path: (dir as NSString).appendingPathComponent("helper/device.key"))
    }

    @Test func usesTheKeychainWhenEntitled() throws {
        let lines = Lines()
        let backend = FakeKeychainBackend()
        let keychain = KeychainDeviceIdentityStore(backend: backend, accessGroup: nil)
        let file = Self.tempFileStore()
        let first = try DeviceIdentityStores.resolve(log: HelperLog(echo: lines.append), keychain: keychain, file: file)
        #expect(first.store.kind == "keychain")
        let second = try DeviceIdentityStores.resolve(log: HelperLog(echo: lines.append), keychain: keychain, file: file)
        #expect(second.identity.publicKey == first.identity.publicKey)
        #expect(lines.all.contains("identity_store=keychain"))
        #expect(try file.load() == nil)
        let item = try #require(backend.snapshot()[.init(service: "com.psyche.helper.identity", account: "device")])
        #expect(item.protection == .accessible(.afterFirstUnlockThisDeviceOnly))
        let encoded = FileDeviceIdentityStore.encode(first.identity)
        #expect(!lines.all.joined().contains(encoded))
    }

    @Test func fallsBackToTheFileOnMissingEntitlement() throws {
        let lines = Lines()
        let backend = FakeKeychainBackend()
        backend.failMutationsWith = errSecMissingEntitlement
        let file = Self.tempFileStore()
        defer { try? FileManager.default.removeItem(atPath: ((file.path as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent) }
        let resolved = try DeviceIdentityStores.resolve(
            log: HelperLog(echo: lines.append), keychain: KeychainDeviceIdentityStore(backend: backend, accessGroup: nil), file: file
        )
        #expect(resolved.store.kind == "file")
        #expect(try file.load()?.publicKey == resolved.identity.publicKey)
        #expect(lines.all.contains { $0.hasPrefix("identity_store=file") })
        let encoded = FileDeviceIdentityStore.encode(resolved.identity)
        #expect(!lines.all.joined().contains(encoded))
    }

    @Test func migratesAFileKeyIntoTheKeychain() throws {
        let lines = Lines()
        let file = Self.tempFileStore()
        defer { try? FileManager.default.removeItem(atPath: ((file.path as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent) }
        let legacy = try file.loadOrCreate()
        let keychain = KeychainDeviceIdentityStore(backend: FakeKeychainBackend(), accessGroup: nil)
        let resolved = try DeviceIdentityStores.resolve(log: HelperLog(echo: lines.append), keychain: keychain, file: file)
        #expect(resolved.store.kind == "keychain")
        #expect(resolved.identity.publicKey == legacy.publicKey)
        #expect(try file.load() == nil)
        #expect(lines.all.contains("identity_migration=file_to_keychain"))
    }

    @Test func otherKeychainErrorsPropagate() {
        let backend = FakeKeychainBackend()
        backend.failMutationsWith = errSecInteractionNotAllowed
        #expect(throws: KeychainOSStatusError(errSecInteractionNotAllowed)) {
            try DeviceIdentityStores.resolve(
                log: HelperLog(echo: { _ in }), keychain: KeychainDeviceIdentityStore(backend: backend, accessGroup: nil), file: Self.tempFileStore()
            )
        }
    }
}
