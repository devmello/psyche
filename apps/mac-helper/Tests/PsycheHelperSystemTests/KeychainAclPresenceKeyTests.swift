import CryptoKit
import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import PsycheWire
import Security
import Testing

/// The keychain in memory: the envelope item, a software seal key and a switch for "the access list
/// names someone else".
final class MemoryAclStore: AclKeychainStore, @unchecked Sendable {
    var payload: Data?
    var sealKey: P256.Signing.PrivateKey?
    var trusted = true
    var wipes = 0

    func loadPayload() throws -> Data? { payload }
    func storePayload(_ p: Data) throws { payload = p }
    func seal(_ message: Data) throws -> Data {
        if sealKey == nil { sealKey = P256.Signing.PrivateKey() }
        return try sealKey!.signature(for: message).derRepresentation
    }
    func verifySeal(_ message: Data, signature: Data) throws -> Bool {
        guard let k = sealKey, let sig = try? P256.Signing.ECDSASignature(derRepresentation: signature) else { return false }
        return k.publicKey.isValidSignature(sig, for: message)
    }
    func isTrusted() throws -> Bool { trusted }
    func wipe() throws {
        wipes += 1
        payload = nil
        sealKey = nil
        trusted = true
    }
}

private struct SoftBackend: EnclaveKeyBackend {
    func create() throws -> Data { P256.Signing.PrivateKey().rawRepresentation }
    func publicKey(blob: Data) throws -> Data { try P256.Signing.PrivateKey(rawRepresentation: blob).publicKey.x963Representation }
    func sign(blob: Data, message: Data, reason: String) async throws -> Data {
        try P256.Signing.PrivateKey(rawRepresentation: blob).signature(for: message).derRepresentation
    }
}

private struct RefusingSoftBackend: EnclaveKeyBackend {
    func create() throws -> Data { P256.Signing.PrivateKey().rawRepresentation }
    func publicKey(blob: Data) throws -> Data { try P256.Signing.PrivateKey(rawRepresentation: blob).publicKey.x963Representation }
    func sign(blob: Data, message: Data, reason: String) async throws -> Data { throw PresenceKeyErrors.refused }
}

final class CreatedCounter: @unchecked Sendable {
    var n = 0
}

@Suite("presence key in the login keychain behind an access list")
struct KeychainAclPresenceKeyTests {
    static let challenge = String(repeating: "0f", count: 32)

    static func key(
        _ store: any AclKeychainStore, backend: any EnclaveKeyBackend = SoftBackend(), state: MutableState = MutableState(Data([1])),
        created: CreatedCounter = CreatedCounter()
    ) -> EnclaveKeychainAclPresenceKey {
        EnclaveKeychainAclPresenceKey(store: store, backend: backend, biometry: state, onCreated: { created.n += 1 })
    }

    @Test func reportsItsKindAndKeepsOneKey() throws {
        let store = MemoryAclStore()
        let first = try Self.key(store).publicKey()
        let again = try Self.key(store).publicKey()
        #expect(first.x963 == again.x963)
        #expect(Self.key(store).keyKind == .enclaveKeychainAcl)
        #expect(PresenceKeyKind.enclaveKeychainAcl.rawValue == "enclave_keychain_acl")
    }

    @Test func signsAVerifiableChallenge() async throws {
        let store = MemoryAclStore()
        let k = Self.key(store)
        let signed = try await k.sign(challenge: Self.challenge, reason: "r")
        let pub = try P256.Signing.PublicKey(x963Representation: try k.publicKey().x963)
        let sig = try P256.Signing.ECDSASignature(derRepresentation: try #require(Base64URL.decode(signed.signature)))
        #expect(pub.isValidSignature(sig, for: PresenceMessage.bytes(challenge: Self.challenge)))
    }

    @Test func retiresTheOldFileKeyOnlyWhenItMakesANewKey() throws {
        let store = MemoryAclStore()
        let created = CreatedCounter()
        _ = try Self.key(store, created: created).publicKey()
        _ = try Self.key(store, created: created).publicKey()
        #expect(created.n == 1)
    }

    @Test func anItemWhoseAccessListNamesAnotherProgramIsNeverAdopted() throws {
        let store = MemoryAclStore()
        let honest = try Self.key(store).publicKey()
        store.trusted = false  // someone planted or re-listed the item
        let after = try Self.key(store).publicKey()
        #expect(after.x963 != honest.x963)
        #expect(store.trusted)  // the replacement is ours again
    }

    @Test func aReplacedItemWithoutOurSealIsNeverAdopted() throws {
        let store = MemoryAclStore()
        let honest = try Self.key(store).publicKey()
        // A same-user process can overwrite the item's data (writing is not guarded): here with a
        // key of its own, and a seal it made itself.
        let attacker = P256.Signing.PrivateKey()
        var forged = EnclaveKeychainAclPresenceKey.magic
        let fakeSig = try P256.Signing.PrivateKey().signature(for: Data("x".utf8)).derRepresentation
        forged.append(contentsOf: [UInt8(fakeSig.count >> 8), UInt8(fakeSig.count & 0xFF)])
        forged.append(fakeSig)
        forged.append(contentsOf: [0, 1, 1])
        forged.append(attacker.rawRepresentation)
        store.payload = forged
        let after = try Self.key(store).publicKey()
        #expect(after.x963 != attacker.publicKey.x963Representation)
        #expect(after.x963 != honest.x963)
        // Garbage is refused the same way.
        store.payload = Data("junk".utf8)
        #expect(try Self.key(store).publicKey().x963 != attacker.publicKey.x963Representation)
    }

    @Test func aChangeWhileRunningIsRefusedUntilRestart() throws {
        let store = MemoryAclStore()
        let k = Self.key(store)
        _ = try k.publicKey()
        store.payload = nil
        #expect(throws: CapabilityError.self) { _ = try k.publicKey() }
        let planted = MemoryAclStore()
        _ = try Self.key(planted).publicKey()
        store.payload = planted.payload
        store.sealKey = planted.sealKey
        #expect(throws: CapabilityError.self) { _ = try k.publicKey() }
    }

    @Test func aChangedEnrollmentHashAloneNeverKillsTheKey() async throws {
        let store = MemoryAclStore()
        let state = MutableState(Data([1]))
        let k = Self.key(store, state: state)
        let id = try k.publicKey().keyId
        state.value = Data([2])
        let signed = try await k.sign(challenge: Self.challenge, reason: "r")
        #expect(signed.keyId == id)
        #expect(try Self.key(store, state: state).publicKey().keyId == id)
        #expect(try k.load()?.state == Data([2]))
    }

    @Test func aKeyTheSecureEnclaveRefusesIsRemovedAndReplaced() async throws {
        let store = MemoryAclStore()
        let k = Self.key(store, backend: RefusingSoftBackend())
        let before = try k.publicKey().keyId
        do {
            _ = try await k.sign(challenge: Self.challenge, reason: "r")
            Issue.record("expected presence_key_invalidated")
        } catch let e as CapabilityError {
            #expect(e.reason == "presence_key_invalidated")
        }
        #expect(try k.publicKey().keyId != before)
    }

    @Test func publicKeyCapabilityReportsTheKind() async throws {
        let cap = try #require(PresenceCapabilities.make(key: Self.key(MemoryAclStore())).first)
        let out = try await cap.invoke(InvocationContext(invocationId: "i", capability: cap.spec.name, params: .null, approvalId: nil, emit: { _ in }))
        #expect(out.result["kind"] == .string("enclave_keychain_acl"))
    }
}

/// The real login-keychain code against a throwaway keychain file. Interaction is off, so a program
/// the access list does not trust gets an error instead of a macOS prompt, and nothing here touches
/// the login keychain.
@Suite("login keychain store (temporary keychain)", .serialized)
struct LoginKeychainAclStoreTests {
    final class TempKeychain {
        let path: String
        let ref: SecKeychain
        init() throws {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("psy-kc-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            path = dir.appendingPathComponent("test.keychain").path
            var kc: SecKeychain?
            let pw = Array("pw".utf8)
            let status = SecKeychainCreate(path, UInt32(pw.count), pw, false, nil, &kc)
            guard status == errSecSuccess, let kc else { throw KeychainOSStatusError(status) }
            ref = kc
        }
        deinit {
            SecKeychainDelete(ref)
            try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent)
        }
    }

    @Test func createsAHelperOnlyItemAndReloadsIt() throws {
        let kc = try TempKeychain()
        SecKeychainSetUserInteractionAllowed(false)
        let store = LoginKeychainAclStore(keychainPath: kc.path, interactionAllowed: false)
        let made = try KeychainAclPresenceKeyTests.key(store).publicKey()
        #expect(try store.isTrusted())
        #expect(try KeychainAclPresenceKeyTests.key(store).publicKey().x963 == made.x963)
    }

    @Test func anOpenItemOrAnOverwrittenOneIsNeverAdopted() throws {
        let kc = try TempKeychain()
        SecKeychainSetUserInteractionAllowed(false)
        let store = LoginKeychainAclStore(keychainPath: kc.path, interactionAllowed: false)
        let made = try KeychainAclPresenceKeyTests.key(store).publicKey()
        // Overwritten data (writing is not guarded): the seal does not verify.
        try store.storePayload(Data("PSYPK2junk-junk-junk".utf8))
        let second = try KeychainAclPresenceKeyTests.key(store).publicKey()
        #expect(second.x963 != made.x963)

        // An item with our name and an open access list (any program): not trusted, replaced.
        try store.wipe()
        var open: SecAccess?
        #expect(SecAccessCreate("open" as CFString, nil, &open) == errSecSuccess)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: LoginKeychainAclStore.service,
            kSecAttrAccount as String: LoginKeychainAclStore.account,
            kSecValueData as String: Data("planted".utf8),
            kSecUseKeychain as String: kc.ref,
            kSecAttrAccess as String: open as Any,
        ]
        #expect(SecItemAdd(add as CFDictionary, nil) == errSecSuccess)
        #expect(try store.isTrusted() == false)
        let third = try KeychainAclPresenceKeyTests.key(store).publicKey()
        #expect(third.x963 != second.x963)
        #expect(try store.isTrusted())
    }

    @Test func theAccessListNamesOnlyThisProgram() throws {
        let kc = try TempKeychain()
        SecKeychainSetUserInteractionAllowed(false)
        let store = LoginKeychainAclStore(keychainPath: kc.path, interactionAllowed: false)
        _ = try KeychainAclPresenceKeyTests.key(store).publicKey()
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: LoginKeychainAclStore.service,
            kSecMatchSearchList as String: [kc.ref],
            kSecReturnRef as String: true,
        ]
        var out: CFTypeRef?
        #expect(SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess)
        var access: SecAccess?
        #expect(SecKeychainItemCopyAccess(out as! SecKeychainItem, &access) == errSecSuccess)  // swiftlint:disable:this force_cast
        var list: CFArray?
        SecAccessCopyACLList(try #require(access), &list)
        for acl in (list as? [SecACL]) ?? [] {
            var apps: CFArray?
            var desc: CFString?
            var sel = SecKeychainPromptSelector()
            SecACLCopyContents(acl, &apps, &desc, &sel)
            let auths = (SecACLCopyAuthorizations(acl) as? [String]) ?? []
            if auths.contains(kSecACLAuthorizationDecrypt as String) {
                #expect((apps as? [SecTrustedApplication])?.count == 1)
            }
        }
        q.removeAll()
    }
}
