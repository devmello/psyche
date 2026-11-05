import CryptoKit
import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import PsycheWire
import Security
import Testing

/// A keychain world in memory: several keychains (only the pinned one, "login", is ever looked at),
/// items and seal keys that may be duplicated or planted, and an "access list names someone else" flag.
final class MemoryAclStore: AclKeychainStore, @unchecked Sendable {
    struct Item {
        var keychain: String
        var payload: Data
        var trusted: Bool
    }

    struct Seal {
        var keychain: String
        var key: P256.Signing.PrivateKey
        var trusted: Bool
    }

    var items: [Item] = []
    var seals: [Seal] = []
    var resets = 0
    var creates = 0
    var rewrites = 0
    /// Models an ACL API that does not keep the list: what create stores is not trusted on read-back.
    var createdIsUntrusted = false
    static let pinned = "login"

    var visibleItems: [Item] { items.filter { $0.keychain == Self.pinned } }
    var visibleSeals: [Seal] { seals.filter { $0.keychain == Self.pinned } }

    func read() throws -> AclStoreRead {
        let i = visibleItems
        let s = visibleSeals
        if i.isEmpty && s.isEmpty { return .absent }
        if i.count > 1 { return .untrusted("more than one Touch ID key item") }
        if s.count > 1 { return .untrusted("more than one seal key") }
        guard let item = i.first, let seal = s.first else { return .untrusted("an item is missing") }
        guard item.trusted, seal.trusted else { return .untrusted("an access list names another program") }
        let pub = seal.key.publicKey
        return .trusted(payload: item.payload, verify: { message, signature in
            guard let sig = try? P256.Signing.ECDSASignature(derRepresentation: signature) else { return false }
            return pub.isValidSignature(sig, for: message)
        })
    }

    func create(_ build: (_ seal: (Data) throws -> Data) throws -> Data) throws {
        guard visibleItems.isEmpty, visibleSeals.isEmpty else { throw PresenceKeyErrors.untrusted("a key is already stored") }
        creates += 1
        let key = P256.Signing.PrivateKey()
        let payload = try build { try key.signature(for: $0).derRepresentation }
        seals.append(Seal(keychain: Self.pinned, key: key, trusted: !createdIsUntrusted))
        items.append(Item(keychain: Self.pinned, payload: payload, trusted: !createdIsUntrusted))
    }

    func rewrite(_ build: (_ seal: (Data) throws -> Data) throws -> Data) throws {
        guard case .trusted = try read() else { throw PresenceKeyErrors.untrusted("not trusted") }
        rewrites += 1
        let key = visibleSeals[0].key
        let payload = try build { try key.signature(for: $0).derRepresentation }
        let idx = items.firstIndex { $0.keychain == Self.pinned }!
        items[idx].payload = payload
    }

    func reset() throws {
        resets += 1
        items.removeAll { $0.keychain == Self.pinned }
        seals.removeAll { $0.keychain == Self.pinned }
    }

    /// What a same-user process can do: write an item and a seal key of its own, with a list that
    /// names the helper, sealed by its own key, holding a blob it made.
    func plant(blob: Data, keychain: String = MemoryAclStore.pinned) {
        let attacker = P256.Signing.PrivateKey()
        var env = EnclaveKeychainAclPresenceKey.magic
        let state = Data([1])
        var message = EnclaveKeychainAclPresenceKey.magic
        message.append(contentsOf: [0, UInt8(state.count)])
        message.append(state)
        message.append(blob)
        let sig = (try? attacker.signature(for: message).derRepresentation) ?? Data()
        env.append(contentsOf: [UInt8(sig.count >> 8), UInt8(sig.count & 0xFF)])
        env.append(sig)
        env.append(contentsOf: [0, UInt8(state.count)])
        env.append(state)
        env.append(blob)
        seals.append(Seal(keychain: keychain, key: attacker, trusted: true))
        items.append(Item(keychain: keychain, payload: env, trusted: true))
    }
}

private struct SoftBackend: EnclaveKeyBackend {
    /// Blobs that sign with no authentication (made without biometry): the probe says so.
    var unauthenticated: Set<Data> = []
    func create() throws -> Data { P256.Signing.PrivateKey().rawRepresentation }
    func publicKey(blob: Data) throws -> Data { try P256.Signing.PrivateKey(rawRepresentation: blob).publicKey.x963Representation }
    func sign(blob: Data, message: Data, reason: String) async throws -> Data {
        try P256.Signing.PrivateKey(rawRepresentation: blob).signature(for: message).derRepresentation
    }
    func signsWithoutAuthentication(blob: Data) -> Bool { unauthenticated.contains(blob) }
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

    static func lockPath() -> String {
        FileManager.default.temporaryDirectory.appendingPathComponent("psy-lock-\(UUID().uuidString)/presence/create.lock").path
    }

    static func key(
        _ store: any AclKeychainStore, backend: any EnclaveKeyBackend = SoftBackend(), state: MutableState = MutableState(Data([1])),
        signed: CreatedCounter = CreatedCounter(), lock: String = KeychainAclPresenceKeyTests.lockPath()
    ) -> EnclaveKeychainAclPresenceKey {
        EnclaveKeychainAclPresenceKey(store: store, backend: backend, biometry: state, lockPath: lock, onFirstSign: { signed.n += 1 })
    }

    static func reason(_ body: () throws -> Void) -> String? {
        do {
            try body()
            return nil
        } catch let e as CapabilityError {
            return e.reason
        } catch {
            return "other"
        }
    }

    @Test func reportsItsKindAndKeepsOneKey() throws {
        let store = MemoryAclStore()
        let first = try Self.key(store).publicKey()
        let again = try Self.key(store).publicKey()
        #expect(first.x963 == again.x963)
        #expect(store.creates == 1)
        #expect(Self.key(store).keyKind == .enclaveKeychainAcl)
        #expect(PresenceKeyKind.enclaveKeychainAcl.rawValue == "enclave_keychain_acl")
    }

    @Test func signsAVerifiableChallengeAndRetiresTheFileKeyOnlyAfterTheFirstSignature() async throws {
        let store = MemoryAclStore()
        let signed = CreatedCounter()
        let k = Self.key(store, signed: signed)
        _ = try k.publicKey()
        #expect(signed.n == 0)  // creating the key does not touch the development file key
        let s = try await k.sign(challenge: Self.challenge, reason: "r")
        _ = try await k.sign(challenge: Self.challenge, reason: "r")
        #expect(signed.n == 1)
        let pub = try P256.Signing.PublicKey(x963Representation: try k.publicKey().x963)
        let sig = try P256.Signing.ECDSASignature(derRepresentation: try #require(Base64URL.decode(s.signature)))
        #expect(pub.isValidSignature(sig, for: PresenceMessage.bytes(challenge: Self.challenge)))
    }

    // MARK: H2 fail closed

    @Test func anUntrustedStateFailsClosedAndNothingIsDeletedOrMade() throws {
        let store = MemoryAclStore()
        _ = try Self.key(store).publicKey()
        store.items[0].trusted = false  // an access list that names another program
        #expect(Self.reason { _ = try Self.key(store).publicKey() } == "presence_key_untrusted")
        #expect(Self.reason { _ = try Self.key(store).existingPublicKey() } == "presence_key_untrusted")
        #expect(store.resets == 0)
        #expect(store.creates == 1)
        #expect(store.items.count == 1)
    }

    @Test func anOverwrittenValueFailsClosedWithoutWiping() throws {
        let store = MemoryAclStore()
        _ = try Self.key(store).publicKey()
        store.items[0].payload = Data("PSYPK2junk-junk-junk-junk".utf8)
        #expect(Self.reason { _ = try Self.key(store).publicKey() } == "presence_key_untrusted")
        store.items[0].payload = Data("junk".utf8)
        #expect(Self.reason { _ = try Self.key(store).publicKey() } == "presence_key_untrusted")
        #expect(store.resets == 0 && store.creates == 1)
    }

    @Test func onlyTheOwnersResetMakesANewKey() throws {
        let store = MemoryAclStore()
        let before = try Self.key(store).publicKey()
        store.items[0].trusted = false
        let k = Self.key(store)
        let after = try k.resetByOwner()
        #expect(after.keyId != before.keyId)
        #expect(store.resets == 1 && store.creates == 2)
        #expect(try Self.key(store).publicKey().keyId == after.keyId)
    }

    // MARK: H1 planted items, other keychains, duplicates, no-biometry keys

    @Test func anAttackerKeychainEarlierInTheSearchListIsNeverSeen() throws {
        let store = MemoryAclStore()
        let attackerBlob = P256.Signing.PrivateKey().rawRepresentation
        store.plant(blob: attackerBlob, keychain: "attacker")
        let mine = try Self.key(store).publicKey()
        #expect(mine.x963 != (try P256.Signing.PrivateKey(rawRepresentation: attackerBlob)).publicKey.x963Representation)
        #expect(store.visibleItems.count == 1 && store.items.count == 2)
    }

    @Test func duplicateItemsOrSealKeysFailClosed() throws {
        let a = MemoryAclStore()
        _ = try Self.key(a).publicKey()
        a.items.append(a.items[0])
        #expect(Self.reason { _ = try Self.key(a).publicKey() } == "presence_key_untrusted")
        let b = MemoryAclStore()
        _ = try Self.key(b).publicKey()
        b.seals.append(MemoryAclStore.Seal(keychain: "login", key: P256.Signing.PrivateKey(), trusted: true))
        #expect(Self.reason { _ = try Self.key(b).publicKey() } == "presence_key_untrusted")
        #expect(a.resets == 0 && b.resets == 0)
    }

    @Test func aPlantedSealKeyIsNeverReusedOrOverwrittenByACreate() throws {
        let store = MemoryAclStore()
        store.seals.append(MemoryAclStore.Seal(keychain: "login", key: P256.Signing.PrivateKey(), trusted: true))
        #expect(Self.reason { _ = try Self.key(store).publicKey() } == "presence_key_untrusted")
        #expect(store.creates == 0)
    }

    @Test func aPlantedKeyMadeWithoutBiometryIsRefusedEvenWhenTheListAndSealPass() throws {
        let store = MemoryAclStore()
        let blob = P256.Signing.PrivateKey().rawRepresentation
        store.plant(blob: blob)  // access list names the helper, sealed by the attacker's own key
        let backend = SoftBackend(unauthenticated: [blob])
        #expect(Self.reason { _ = try Self.key(store, backend: backend).publicKey() } == "presence_key_untrusted")
        #expect(store.resets == 0 && store.creates == 0)
        // A key that needs Touch ID (the probe says it cannot sign alone) is adopted.
        let ok = MemoryAclStore()
        ok.plant(blob: blob)
        #expect(try Self.key(ok, backend: SoftBackend()).publicKey().keyId.count == 64)
    }

    @Test func theBiometryProbeRunsOncePerProcessAndNeverOnTheCreatedKey() throws {
        final class Counting: EnclaveKeyBackend, @unchecked Sendable {
            var probes = 0
            func create() throws -> Data { P256.Signing.PrivateKey().rawRepresentation }
            func publicKey(blob: Data) throws -> Data { try P256.Signing.PrivateKey(rawRepresentation: blob).publicKey.x963Representation }
            func sign(blob: Data, message: Data, reason: String) async throws -> Data { Data() }
            func signsWithoutAuthentication(blob: Data) -> Bool {
                probes += 1
                return false
            }
        }
        let backend = Counting()
        let k = Self.key(MemoryAclStore(), backend: backend)
        _ = try k.publicKey()
        _ = try k.publicKey()
        _ = try k.publicKey()
        #expect(backend.probes == 1)
    }

    // MARK: M3, M4

    @Test func aFailedReadBackStopsWithoutRetryOrChurn() throws {
        let store = MemoryAclStore()
        store.createdIsUntrusted = true
        let k = Self.key(store)
        #expect(Self.reason { _ = try k.publicKey() } == "presence_key_acl_unavailable")
        #expect(Self.reason { _ = try k.publicKey() } == "presence_key_acl_unavailable")
        #expect(store.creates == 1 && store.resets == 0)
    }

    @Test func printIdentityIsReadOnly() throws {
        let store = MemoryAclStore()
        let lock = Self.lockPath()
        let k = Self.key(store, lock: lock)
        #expect(try k.existingPublicKey() == nil)
        #expect(store.creates == 0 && store.resets == 0 && store.rewrites == 0)
        #expect(!FileManager.default.fileExists(atPath: lock))  // not even the creation lock
        let made = try k.publicKey()
        #expect(try k.existingPublicKey()?.keyId == made.keyId)
        #expect(FileManager.default.fileExists(atPath: lock))
        var st = stat()
        lstat(lock, &st)
        #expect(UInt16(st.st_mode & 0o7777) == 0o600)
        // Untrusted state: reading reports it and changes nothing.
        store.items[0].trusted = false
        #expect(Self.reason { _ = try Self.key(store).existingPublicKey() } == "presence_key_untrusted")
        #expect(store.resets == 0 && store.rewrites == 0 && store.creates == 1)
    }

    // MARK: key behaviour kept from before

    @Test func aChangeWhileRunningIsRefusedUntilRestart() throws {
        let store = MemoryAclStore()
        let k = Self.key(store)
        _ = try k.publicKey()
        let saved = (store.items, store.seals)
        store.items = []
        store.seals = []
        #expect(Self.reason { _ = try k.publicKey() } == "presence_key_changed")
        let other = MemoryAclStore()
        _ = try Self.key(other).publicKey()
        store.items = other.items
        store.seals = other.seals
        #expect(Self.reason { _ = try k.publicKey() } == "presence_key_changed")
        _ = saved
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
        #expect(try k.current(create: false)?.env.state == Data([2]))
    }

    @Test func aKeyTheSecureEnclaveRefusesIsRemovedAndReplacedByTheNextUse() async throws {
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

@Suite("access list audit decisions")
struct AclAuditTests {
    let read = ["ACLAuthorizationDecrypt", "ACLAuthorizationSign"]
    let own = "/Applications/Psyche.app/Contents/MacOS/psyche-helper"

    @Test func onlyTheExactResolvedPathOfThisProgramPasses() {
        #expect(AclAudit.judge(auths: read, apps: [own], ownPath: own) == .ok(isRead: true))
        // Same name elsewhere, a lookalike, a relative path or no known own path: refused.
        #expect(AclAudit.judge(auths: read, apps: ["/tmp/x/psyche-helper"], ownPath: own) == .reject)
        #expect(AclAudit.judge(auths: read, apps: [own + "2"], ownPath: own) == .reject)
        #expect(AclAudit.judge(auths: read, apps: ["psyche-helper"], ownPath: own) == .reject)
        #expect(AclAudit.judge(auths: read, apps: [own], ownPath: nil) == .reject)
        #expect(AclAudit.judge(auths: read, apps: [own, "/tmp/other"], ownPath: own) == .reject)
        #expect(AclAudit.judge(auths: read, apps: [nil], ownPath: own) == .reject)
    }

    @Test func openOrEmptyReadListsAreRefusedButTheChangeEntryMayBeEmpty() {
        #expect(AclAudit.judge(auths: read, apps: nil, ownPath: own) == .reject)
        #expect(AclAudit.judge(auths: read, apps: [], ownPath: own) == .reject)
        #expect(AclAudit.judge(auths: ["ACLAuthorizationChangeACL"], apps: [], ownPath: own) == .ok(isRead: false))
        #expect(AclAudit.judge(auths: ["ACLAuthorizationChangeACL"], apps: nil, ownPath: own) == .reject)
        #expect(AclAudit.judge(auths: ["ACLAuthorizationAny"], apps: nil, ownPath: own) == .reject)
    }

    @Test func encryptAndPartitionEntriesNeverRejectTheHelpersOwnItems() {
        #expect(AclAudit.judge(auths: ["ACLAuthorizationEncrypt"], apps: nil, ownPath: own) == .skip)
        #expect(AclAudit.judge(auths: ["ACLAuthorizationPartitionID"], apps: nil, ownPath: own) == .skip)
        #expect(AclAudit.judge(auths: ["ACLAuthorizationPartitionID"], apps: [], ownPath: own) == .skip)
    }
}

/// The real login-keychain code against a throwaway keychain file. Interaction is off, so a program
/// the access list does not trust gets an error instead of a macOS prompt, and nothing here touches
/// the login keychain or the user's search list.
@Suite("login keychain store (temporary keychain)", .serialized)
struct LoginKeychainAclStoreTests {
    final class TempKeychain {
        let dir: URL
        let path: String
        let ref: SecKeychain
        init() throws {
            SecKeychainSetUserInteractionAllowed(false)
            dir = FileManager.default.temporaryDirectory.appendingPathComponent("psy-kc-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            path = dir.appendingPathComponent("test.keychain").path
            var kc: SecKeychain?
            let pw = Array("pw".utf8)
            let status = SecKeychainCreate(path, UInt32(pw.count), pw, false, nil, &kc)
            guard status == errSecSuccess, let kc else { throw KeychainOSStatusError(status) }
            ref = kc
        }
        deinit {
            // Never in the user's search list; make sure of it even if a test failed half way.
            var list: CFArray?
            if SecKeychainCopySearchList(&list) == errSecSuccess, let kcs = list as? [SecKeychain] {
                let keep = kcs.filter { kc in
                    var len: UInt32 = 1024
                    var buf = [CChar](repeating: 0, count: 1024)
                    SecKeychainGetPath(kc, &len, &buf)
                    return String(cString: buf) != path
                }
                if keep.count != kcs.count { SecKeychainSetSearchList(keep as CFArray) }
            }
            SecKeychainDelete(ref)
            try? FileManager.default.removeItem(at: dir)
        }
    }

    static func key(_ store: LoginKeychainAclStore) -> EnclaveKeychainAclPresenceKey {
        KeychainAclPresenceKeyTests.key(store)
    }

    /// An access list for a planted item: open to any program (`trusted: nil`), or naming one program.
    static func plantedAccess(trusted path: String?) -> SecAccess? {
        var apps: [SecTrustedApplication] = []
        if let path {
            var app: SecTrustedApplication?
            SecTrustedApplicationCreateFromPath(path, &app)
            apps = app.map { [$0] } ?? []
        }
        var access: SecAccess?
        SecAccessCreate("planted" as CFString, apps as CFArray, &access)
        var list: CFArray?
        SecAccessCopyACLList(access!, &list)
        for acl in (list as? [SecACL]) ?? [] {
            let auths = (SecACLCopyAuthorizations(acl) as? [String]) ?? []
            if auths.contains(kSecACLAuthorizationChangeACL as String) { continue }
            var cur: CFArray?
            var desc: CFString?
            var sel = SecKeychainPromptSelector()
            SecACLCopyContents(acl, &cur, &desc, &sel)
            SecACLSetContents(acl, path == nil ? nil : apps as CFArray, desc ?? "planted" as CFString, sel)
        }
        return access
    }

    static func plant(in kc: TempKeychain, access: SecAccess?) {
        let seal: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256,
            kSecAttrIsPermanent as String: true, kSecAttrLabel as String: LoginKeychainAclStore.sealLabel,
            kSecAttrAccess as String: access as Any, kSecUseKeychain as String: kc.ref,
        ]
        #expect(SecKeyCreateRandomKey(seal as CFDictionary, nil) != nil)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: LoginKeychainAclStore.service,
            kSecAttrAccount as String: LoginKeychainAclStore.account, kSecValueData as String: Data("planted".utf8),
            kSecUseKeychain as String: kc.ref, kSecAttrAccess as String: access as Any,
        ]
        #expect(SecItemAdd(add as CFDictionary, nil) == errSecSuccess)
    }

    @Test func createsAHelperOnlyItemAndReloadsIt() throws {
        let kc = try TempKeychain()
        let store = LoginKeychainAclStore(keychainPath: kc.path, interactionAllowed: false)
        let made = try Self.key(store).publicKey()
        guard case .trusted = try store.read() else { Issue.record("expected a trusted read-back"); return }
        #expect(try Self.key(store).publicKey().x963 == made.x963)
        #expect(try Self.key(store).existingPublicKey()?.x963 == made.x963)
        // A second create is refused: nothing of ours is overwritten or reused.
        #expect(throws: CapabilityError.self) { try store.create { _ in Data() } }
    }

    @Test func anOverwrittenItemFailsClosedAndStaysWhereItIs() throws {
        let kc = try TempKeychain()
        let store = LoginKeychainAclStore(keychainPath: kc.path, interactionAllowed: false)
        _ = try Self.key(store).publicKey()
        // Overwritten data (writing is not guarded): the seal does not verify.
        let update = SecItemUpdate(
            [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: LoginKeychainAclStore.service,
             kSecMatchSearchList as String: [kc.ref]] as CFDictionary,
            [kSecValueData as String: Data("PSYPK2junk-junk-junk".utf8)] as CFDictionary
        )
        #expect(update == errSecSuccess)
        #expect(KeychainAclPresenceKeyTests.reason { _ = try Self.key(store).publicKey() } == "presence_key_untrusted")
        // Still stored, not deleted: only an owner reset removes it.
        guard case .trusted(let payload, _) = try store.read() else { Issue.record("the overwritten item was removed"); return }
        #expect(payload == Data("PSYPK2junk-junk-junk".utf8))
    }

    @Test func aListNamingAnotherProgramFailsClosed() throws {
        let kc = try TempKeychain()
        let store = LoginKeychainAclStore(keychainPath: kc.path, interactionAllowed: false)
        Self.plant(in: kc, access: Self.plantedAccess(trusted: "/usr/bin/true"))
        guard case .untrusted = try store.read() else { Issue.record("a foreign list was trusted"); return }
        #expect(throws: CapabilityError.self) { try store.create { _ in Data() } }
        #expect(KeychainAclPresenceKeyTests.reason { _ = try Self.key(store).publicKey() } == "presence_key_untrusted")
    }

    @Test func openListsAndDuplicateSealKeysFailClosed() throws {
        let kc = try TempKeychain()
        let store = LoginKeychainAclStore(keychainPath: kc.path, interactionAllowed: false)
        // A planted item and seal key, both with an open access list (any program).
        Self.plant(in: kc, access: Self.plantedAccess(trusted: nil))
        guard case .untrusted = try store.read() else { Issue.record("an open list was trusted"); return }
        #expect(KeychainAclPresenceKeyTests.reason { _ = try Self.key(store).publicKey() } == "presence_key_untrusted")
        // Only the owner's reset replaces it.
        let fresh = try Self.key(store).resetByOwner()
        #expect(fresh.keyId.count == 64)
        guard case .trusted = try store.read() else { Issue.record("expected a trusted key after reset"); return }
        // A second seal key with the same label makes it ambiguous: fail closed.
        let dup: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256,
            kSecAttrIsPermanent as String: true, kSecAttrLabel as String: LoginKeychainAclStore.sealLabel,
            kSecUseKeychain as String: kc.ref,
        ]
        #expect(SecKeyCreateRandomKey(dup as CFDictionary, nil) != nil)
        guard case .untrusted = try store.read() else { Issue.record("a duplicate seal key was trusted"); return }
    }

    @Test func aLinkedKeychainFileIsRefused() throws {
        let kc = try TempKeychain()
        let link = kc.dir.appendingPathComponent("link.keychain").path
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: kc.path)
        let store = LoginKeychainAclStore(keychainPath: link, interactionAllowed: false)
        #expect(KeychainAclPresenceKeyTests.reason { _ = try store.read() } == "presence_key_untrusted")
    }

    @Test func theAccessListNamesOnlyThisProgram() throws {
        let kc = try TempKeychain()
        let store = LoginKeychainAclStore(keychainPath: kc.path, interactionAllowed: false)
        _ = try Self.key(store).publicKey()
        let q: [String: Any] = [
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
                let paths = ((apps as? [SecTrustedApplication]) ?? []).compactMap(AclAudit.entryPath)
                #expect(paths == [AclAudit.ownPath()].compactMap { $0 })
            }
        }
    }
}
