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

    @Test func declaresTheManifest() {
        let specs = Dictionary(uniqueKeysWithValues: registry.ordered.map { ($0.spec.name, $0.spec) })
        #expect(Set(specs.keys) == [
            "keychain.wrap_key", "keychain.unwrap_key", "keychain.store", "keychain.retrieve", "keychain.delete", "keychain.status",
        ])
        #expect(specs["keychain.wrap_key"]?.sideEffect == .write)
        #expect(specs["keychain.wrap_key"]?.receiptKind == "vault_key")
        #expect(specs["keychain.unwrap_key"]?.sideEffect == .read)
        #expect(specs["keychain.unwrap_key"]?.description.contains("SECRET") == true)
        #expect(specs["keychain.store"]?.sideEffect == .write)
        #expect(specs["keychain.retrieve"]?.sideEffect == .read)
        #expect(specs["keychain.delete"]?.sideEffect == .destructive)
        #expect(specs["keychain.status"]?.sideEffect == .read)
        #expect(specs["keychain.unwrap_key"]?.inputSchema["required"] == ["reason", "slot", "wrapped"])
    }

    @Test func wrapUnwrapThroughCapabilities() async throws {
        let dek = Base64URL.encode(Data(repeating: 7, count: 32))
        let wrap = try await invoke("keychain.wrap_key", ["slot": "vault.main", "dek": .string(dek)])
        #expect(wrap.receipt?.outcome == .ok)
        #expect(wrap.result["replaced"] == false)
        #expect(wrap.result["dek"] == nil)
        #expect(!wrap.result.jsonString().contains(dek))
        let wrapped = try #require(wrap.result["wrapped"]?.stringValue)
        let unwrap = try await invoke("keychain.unwrap_key", ["slot": "vault.main", "wrapped": .string(wrapped), "reason": "unlock your vault"])
        #expect(unwrap.result["dek"] == .string(dek))
        #expect(unwrap.receipt == nil)
    }

    @Test func storeNeverEchoesTheValue() async throws {
        let value = Base64URL.encode(Data("s3cret-value".utf8))
        let out = try await invoke("keychain.store", ["name": "api.key", "value": .string(value)])
        #expect(!out.result.jsonString().contains(value))
        #expect(out.result["requireAuth"] == true)
        #expect(out.receipt?.summary.contains("s3cret") == false)
        let back = try await invoke("keychain.retrieve", ["name": "api.key", "reason": "use the key"])
        #expect(back.result["value"] == .string(value))
        let del = try await invoke("keychain.delete", ["name": "api.key"])
        #expect(del.result["kind"] == "item")
        #expect(del.receipt != nil)
    }

    @Test func validatesParams() async {
        await expectCapabilityError(.invalidParams, "invalid_params") {
            _ = try await invoke("keychain.unwrap_key", ["slot": "s", "wrapped": "x"]) // reason missing
        }
        await expectCapabilityError(.invalidParams, "invalid_params") {
            _ = try await invoke("keychain.retrieve", ["name": "n", "reason": .string(String(repeating: "x", count: 121))])
        }
        await expectCapabilityError(.invalidParams, "invalid_params") {
            _ = try await invoke("keychain.delete", ["slot": "s", "name": "n"])
        }
        await expectCapabilityError(.invalidParams, "invalid_params") {
            _ = try await invoke("keychain.delete", [:])
        }
        await expectCapabilityError(.invalidParams, "invalid_params") {
            _ = try await invoke("keychain.wrap_key", ["slot": "s", "dek": "!!"])
        }
        await expectCapabilityError(.invalidParams, "invalid_params") {
            _ = try await invoke("keychain.store", ["name": "UPPER", "value": "AQ"])
        }
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
