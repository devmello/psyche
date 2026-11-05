import CryptoKit
import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
import PsycheWire
import Testing

private struct FakeSigner: PresenceSigning {
    var result: Result<PresenceSignature, CapabilityError>
    func publicKey() throws -> (x963: Data, keyId: String) { (Data([4]), "k") }
    func sign(challenge: String, reason: String) async throws -> PresenceSignature { try result.get() }
}

@Suite("presence key (issue #84)")
struct PresenceKeyTests {
    static let challenge = String(repeating: "0f", count: 32)

    @Test func signsTheDomainSeparatedChallengeVerifiably() async throws {
        // Same SecKey path as the Secure Enclave key, with a software key (no Touch ID in CI).
        let key = PresenceKey(secureEnclave: false)
        let (x963, keyId) = try key.publicKey()
        #expect(x963.count == 65 && x963.first == 0x04)  // X9.63 uncompressed
        #expect(keyId == PresenceMessage.keyId(x963: x963))
        let assertion = try await key.sign(challenge: Self.challenge, reason: "test")
        #expect(assertion.keyId == keyId)
        let pub = try P256.Signing.PublicKey(x963Representation: x963)
        let sig = try P256.Signing.ECDSASignature(derRepresentation: try #require(Base64URL.decode(assertion.signature)))
        #expect(pub.isValidSignature(sig, for: PresenceMessage.bytes(challenge: Self.challenge)))
        // Bound to the challenge and the domain.
        #expect(!pub.isValidSignature(sig, for: Data(Self.challenge.utf8)))
        #expect(!pub.isValidSignature(sig, for: PresenceMessage.bytes(challenge: String(repeating: "1f", count: 32))))
        await #expect(throws: CapabilityError.self) { try await key.sign(challenge: "nothex", reason: "x") }
    }

    @Test func publicKeyCapability() async throws {
        let key = PresenceKey(secureEnclave: false)
        let cap = try #require(PresenceCapabilities.make(key: key).first)
        #expect(cap.spec.name == "presence.public_key" && cap.spec.sideEffect == .read)
        let out = try await cap.invoke(InvocationContext(invocationId: "i", capability: cap.spec.name, params: .null, approvalId: nil, emit: { _ in }))
        let raw = try #require(out.result["publicKey"]?.stringValue.flatMap(Base64URL.decode))
        #expect(out.result["keyId"] == .string(PresenceMessage.keyId(x963: raw)))
    }

    @Test func answersCarryTheAssertionOrTheRefusal() async {
        let base = NotificationResponse(notificationId: "apr_1", actionId: "approve", approvalId: "apr_1")
        let ok = await NotificationCenterBridge.answer(
            base, challenge: Self.challenge, presence: FakeSigner(result: .success(PresenceSignature(signature: "s", keyId: "k"))), reason: "r")
        #expect(ok.authenticated && ok.presence == PresenceSignature(signature: "s", keyId: "k"))
        let cancelled = await NotificationCenterBridge.answer(
            base, challenge: Self.challenge,
            presence: FakeSigner(result: .failure(CapabilityError(.cancelled, reason: "user_cancelled", "x"))), reason: "r")
        #expect(!cancelled.authenticated && cancelled.presence == nil && cancelled.authError == "user_cancelled")
        // Without a usable key (unsigned build) the answer carries no presence; the Gateway refuses it.
        let noKey = await NotificationCenterBridge.answer(
            base, challenge: Self.challenge,
            presence: FakeSigner(result: .failure(CapabilityError(.unavailable, reason: "missing_entitlement", "x"))), reason: "r",
            authenticate: { _ in nil })
        #expect(noKey.presence == nil && noKey.presenceError == "missing_entitlement" && noKey.authenticated)
    }

    private static func confirmCap(_ key: any PresenceSigning) throws -> any CapabilityHandler {
        try #require(PresenceCapabilities.make(key: key).first { $0.spec.name == "presence.confirm" })
    }

    private static func ctx(_ params: JSONValue) -> InvocationContext {
        InvocationContext(invocationId: "i", capability: "presence.confirm", params: params, approvalId: nil, emit: { _ in })
    }

    private static func confirmParams(summary: String = "Run `date` on this Mac", code: String = "ab12-cd34", challenge: String = challenge) -> JSONValue {
        .object(["challenge": .string(challenge), "summary": .string(summary), "code": .string(code)])
    }

    @Test func confirmSignsTheApprovalChallengeForTheWindow() async throws {
        let key = PresenceKey(secureEnclave: false)
        let cap = try Self.confirmCap(key)
        let out = try await cap.invoke(Self.ctx(Self.confirmParams()))
        let (x963, keyId) = try key.publicKey()
        #expect(out.result["keyId"] == .string(keyId))
        let der = try #require(out.result["signature"]?.stringValue.flatMap(Base64URL.decode))
        let pub = try P256.Signing.PublicKey(x963Representation: x963)
        #expect(pub.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: der), for: PresenceMessage.bytes(challenge: Self.challenge)))
    }

    @Test func confirmRefusesBadParamsAndPassesTheCancel() async throws {
        let cap = try Self.confirmCap(PresenceKey(secureEnclave: false))
        for bad in [
            Self.confirmParams(challenge: "nothex"), Self.confirmParams(summary: "  "),
            Self.confirmParams(code: "ABCD-1234"), Self.confirmParams(code: "ab12cd34"),
        ] {
            await #expect(throws: CapabilityError.self) { _ = try await cap.invoke(Self.ctx(bad)) }
        }
        let cancelling = try Self.confirmCap(FakeSigner(result: .failure(CapabilityError(.cancelled, reason: "user_cancelled", "x"))))
        do {
            _ = try await cancelling.invoke(Self.ctx(Self.confirmParams()))
            Issue.record("expected a cancel")
        } catch let e as CapabilityError {
            #expect(e.code == .cancelled && e.reason == "user_cancelled")
        }
    }

    @Test func theSheetNamesTheApprovalAndItsCode() {
        let r = PresenceCapabilities.confirmReason(summary: "Run `date`\non this Mac", code: "ab12-cd34")
        #expect(r == "approve code ab12-cd34: \u{201C}Run `date` on this Mac\u{201D} in Psyche")
        #expect(PresenceCapabilities.confirmReason(summary: String(repeating: "a", count: 500), code: "ab12-cd34").count <= 140)
        #expect(!PresenceCapabilities.confirmReason(summary: "a\u{0007}b", code: "ab12-cd34").contains("\u{0007}"))
    }

    @Test func aChangedEnrollmentHashAloneNeverKillsTheKeychainKey() async throws {
        // An OS update can change the hash without a fingerprint change: still sign, keep the key.
        let state = MutableState(Data([1]))
        let key = PresenceKey(secureEnclave: false, biometry: state)
        let before = try key.publicKey().keyId
        _ = try await key.sign(challenge: Self.challenge, reason: "r")
        state.value = Data([2])
        let signed = try await key.sign(challenge: Self.challenge, reason: "r")
        #expect(signed.keyId == before)
        #expect(try key.publicKey().keyId == before)
        // The new state is recorded, so the next signature sees no change.
        #expect(key.recordedState() == Data([2]))
    }
}

/// A Touch ID enrollment state the test changes.
final class MutableState: BiometryStateSource, @unchecked Sendable {
    var value: Data?
    init(_ value: Data?) { self.value = value }
    func current() -> Data? { value }
}

/// A software P-256 key standing in for the Secure Enclave: its raw representation is the "blob".
private struct SoftwareBackend: EnclaveKeyBackend {
    func create() throws -> Data { P256.Signing.PrivateKey().rawRepresentation }
    func publicKey(blob: Data) throws -> Data { try P256.Signing.PrivateKey(rawRepresentation: blob).publicKey.x963Representation }
    func sign(blob: Data, message: Data, reason: String) async throws -> Data {
        try P256.Signing.PrivateKey(rawRepresentation: blob).signature(for: message).derRepresentation
    }
}

/// A key the Secure Enclave refuses after Touch ID passed.
private struct RefusingBackend: EnclaveKeyBackend {
    func create() throws -> Data { P256.Signing.PrivateKey().rawRepresentation }
    func publicKey(blob: Data) throws -> Data { try P256.Signing.PrivateKey(rawRepresentation: blob).publicKey.x963Representation }
    func sign(blob: Data, message: Data, reason: String) async throws -> Data { throw PresenceKeyErrors.refused }
}

/// The seal secret in memory (the live one is in the login keychain).
final class MemorySealer: PresenceFileSealer, @unchecked Sendable {
    var key: SymmetricKey?
    func newSecret() throws -> SymmetricKey {
        let k = SymmetricKey(size: .bits256)
        key = k
        return k
    }
    func secret() throws -> SymmetricKey? { key }
    func removeSecret() { key = nil }
}

private struct KeyedFake: PresenceSigning {
    var kind: PresenceKeyKind
    var failure: CapabilityError?
    var keyKind: PresenceKeyKind { kind }
    func publicKey() throws -> (x963: Data, keyId: String) {
        if let failure { throw failure }
        return (Data([4]), kind.rawValue)
    }
    func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        PresenceSignature(signature: kind.rawValue, keyId: kind.rawValue)
    }
}

@Suite("presence key fallback for builds without a provisioning profile")
struct EnclaveFilePresenceKeyTests {
    static let challenge = String(repeating: "0f", count: 32)

    static func tempPath() -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("psy-pk-\(UUID().uuidString)")
        return dir.appendingPathComponent("presence/presence-key.se").path
    }

    static func mode(_ path: String) -> UInt16 {
        var st = stat()
        lstat(path, &st)
        return UInt16(st.st_mode & 0o7777)
    }

    static func fileKey(_ path: String, sealer: MemorySealer = MemorySealer(), state: MutableState = MutableState(Data([1]))) -> EnclaveFilePresenceKey {
        EnclaveFilePresenceKey(path: path, backend: SoftwareBackend(), sealer: sealer, biometry: state)
    }

    @Test func keepsTheKeychainKeyWhenTheBuildCanHoldIt() async throws {
        let k = PreferredPresenceKey(primary: KeyedFake(kind: .keychain), aclKey: KeyedFake(kind: .enclaveKeychainAcl), fileKey: KeyedFake(kind: .enclaveFile), fileKeyAllowed: true)
        #expect(try k.publicKey().keyId == "keychain")
        #expect(k.keyKind == .keychain)
        #expect(try await k.sign(challenge: Self.challenge, reason: "r").signature == "keychain")
    }

    @Test func usesTheKeychainAclKeyOnMissingEntitlementInEveryBuild() async throws {
        let noProfile = CapabilityError(.unavailable, reason: "missing_entitlement", "x")
        let k = PreferredPresenceKey(primary: KeyedFake(kind: .keychain, failure: noProfile), aclKey: KeyedFake(kind: .enclaveKeychainAcl), fileKey: KeyedFake(kind: .enclaveFile), fileKeyAllowed: false)
        #expect(try k.publicKey().keyId == "enclave_keychain_acl")
        #expect(k.keyKind == .enclaveKeychainAcl)
        // Any other keychain failure is reported, never papered over with another kind.
        let locked = CapabilityError(.forbidden, reason: "interaction_not_allowed", "x")
        let other = PreferredPresenceKey(primary: KeyedFake(kind: .keychain, failure: locked), aclKey: KeyedFake(kind: .enclaveKeychainAcl), fileKey: KeyedFake(kind: .enclaveFile), fileKeyAllowed: true)
        #expect(throws: CapabilityError.self) { _ = try other.publicKey() }
        #expect(other.keyKind == .keychain)
    }

    @Test func theFileKeyNeedsADevelopmentBuildAndTheOptIn() async throws {
        let noProfile = CapabilityError(.unavailable, reason: "missing_entitlement", "x")
        let k = PreferredPresenceKey(primary: KeyedFake(kind: .keychain, failure: noProfile), aclKey: KeyedFake(kind: .enclaveKeychainAcl), fileKey: KeyedFake(kind: .enclaveFile), fileKeyAllowed: true)
        // Allowed only when the build has the fallback (a PSYCHE_PUBLIC_RELEASE=1 build never does).
        #expect(k.keyKind == (PreferredPresenceKey.fallbackBuiltIn ? .enclaveFile : .enclaveKeychainAcl))
    }

    @Test func writesTheSealedFile0600InA0700FolderAndReusesIt() async throws {
        let path = Self.tempPath()
        let sealer = MemorySealer()
        let key = Self.fileKey(path, sealer: sealer)
        let (x963, keyId) = try key.publicKey()
        #expect(Self.mode(path) == 0o600)
        #expect(Self.mode((path as NSString).deletingLastPathComponent) == 0o700)
        // The same key on the next start (same seal), and its signature verifies against it.
        let again = Self.fileKey(path, sealer: sealer)
        #expect(try again.publicKey().keyId == keyId)
        let signed = try await again.sign(challenge: Self.challenge, reason: "r")
        #expect(signed.keyId == keyId)
        let pub = try P256.Signing.PublicKey(x963Representation: x963)
        let sig = try P256.Signing.ECDSASignature(derRepresentation: try #require(Base64URL.decode(signed.signature)))
        #expect(pub.isValidSignature(sig, for: PresenceMessage.bytes(challenge: Self.challenge)))
        #expect(key.keyKind == .enclaveFile)
    }

    @Test func aPlantedBlobIsNeverUsed() throws {
        let path = Self.tempPath()
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // Another process writes a blob of its own (made without biometry, say), even a well-formed
        // file sealed with a secret the helper does not hold.
        let plantedKey = P256.Signing.PrivateKey()
        let plantedSecret = SymmetricKey(size: .bits256)
        var planted = Data("PSYPK1".utf8)
        planted.append(EnclaveFilePresenceKey.mac(plantedSecret, state: Data(), blob: plantedKey.rawRepresentation))
        planted.append(contentsOf: [0, 0])
        planted.append(plantedKey.rawRepresentation)
        FileManager.default.createFile(atPath: path, contents: planted, attributes: [.posixPermissions: 0o600])
        let key = Self.fileKey(path)
        let x963 = try key.publicKey().x963
        #expect(x963 != plantedKey.publicKey.x963Representation)
        #expect(FileManager.default.fileExists(atPath: path + ".rejected"))
    }

    @Test func aChangedFileIsRefusedWhileRunning() throws {
        let path = Self.tempPath()
        let sealer = MemorySealer()
        let key = Self.fileKey(path, sealer: sealer)
        _ = try key.publicKey()
        // Replaced with another correctly sealed key (the strongest attacker): still refused.
        unlink(path)
        _ = try Self.fileKey(path, sealer: sealer).publicKey()
        do {
            _ = try key.publicKey()
            Issue.record("expected presence_key_changed")
        } catch let e as CapabilityError {
            #expect(e.reason == "presence_key_changed")
        }
    }

    @Test func aChangedEnrollmentHashAloneNeverKillsTheFileKey() async throws {
        let path = Self.tempPath()
        let sealer = MemorySealer()
        let state = MutableState(Data([7]))
        let key = Self.fileKey(path, sealer: sealer, state: state)
        let before = try key.publicKey().keyId
        state.value = Data([8])
        let signed = try await key.sign(challenge: Self.challenge, reason: "r")
        #expect(signed.keyId == before)
        #expect(FileManager.default.fileExists(atPath: path))
        // Re-sealed with the new state: a fresh process loads the same key and sees no change.
        #expect(try Self.fileKey(path, sealer: sealer, state: state).current().sealed.state == Data([8]))
    }

    @Test func aKeyTheSecureEnclaveRefusesIsMovedAsideNotDeleted() async throws {
        let path = Self.tempPath()
        let sealer = MemorySealer()
        let state = MutableState(Data([7]))
        let key = EnclaveFilePresenceKey(path: path, backend: RefusingBackend(), sealer: sealer, biometry: state)
        let before = try key.publicKey().keyId
        state.value = Data([8])
        do {
            _ = try await key.sign(challenge: Self.challenge, reason: "r")
            Issue.record("expected presence_key_invalidated")
        } catch let e as CapabilityError {
            #expect(e.reason == "presence_key_invalidated")
            #expect(e.details["enrollmentChanged"] == .bool(true))
        }
        let dir = (path as NSString).deletingLastPathComponent
        let kept = try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.hasPrefix("presence-key.se.retired-") }
        #expect(kept.count == 1)
        #expect(!FileManager.default.fileExists(atPath: path))
        #expect(try key.publicKey().keyId != before)
    }

    @Test func tightensALooseFolderAndRefusesALooseOrLinkedFile() throws {
        let path = Self.tempPath()
        let dir = (path as NSString).deletingLastPathComponent
        let sealer = MemorySealer()
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        _ = try Self.fileKey(path, sealer: sealer).publicKey()
        #expect(Self.mode(dir) == 0o700)

        chmod(path, 0o644)
        #expect(throws: CapabilityError.self) { _ = try Self.fileKey(path, sealer: sealer).publicKey() }

        let linked = Self.tempPath()
        try FileManager.default.createDirectory(atPath: (linked as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        symlink(path, linked)
        #expect(throws: CapabilityError.self) { _ = try Self.fileKey(linked, sealer: sealer).publicKey() }
    }

    @Test func publicKeyCapabilityReportsTheKind() async throws {
        let key = Self.fileKey(Self.tempPath())
        let cap = try #require(PresenceCapabilities.make(key: key).first)
        let out = try await cap.invoke(InvocationContext(invocationId: "i", capability: cap.spec.name, params: .null, approvalId: nil, emit: { _ in }))
        #expect(out.result["kind"] == .string("enclave_file"))
        let keychain = try #require(PresenceCapabilities.make(key: PresenceKey(secureEnclave: false)).first)
        let k = try await keychain.invoke(InvocationContext(invocationId: "i", capability: cap.spec.name, params: .null, approvalId: nil, emit: { _ in }))
        #expect(k.result["kind"] == .string("keychain"))
    }
}
