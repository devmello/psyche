import CryptoKit
import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import PsycheProtocol
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

    @Test func confirmSignsTheApprovalChallengeForTheWindow() async throws {
        let key = PresenceKey(secureEnclave: false)
        let cap = try Self.confirmCap(key)
        let out = try await cap.invoke(Self.ctx(.object(["challenge": .string(Self.challenge), "header": .string("Run command on this Mac")])))
        let (x963, keyId) = try key.publicKey()
        #expect(out.result["keyId"] == .string(keyId))
        let der = try #require(out.result["signature"]?.stringValue.flatMap(Base64URL.decode))
        let pub = try P256.Signing.PublicKey(x963Representation: x963)
        #expect(pub.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: der), for: PresenceMessage.bytes(challenge: Self.challenge)))
    }

    @Test func confirmRefusesBadParamsAndPassesTheCancel() async throws {
        let cap = try Self.confirmCap(PresenceKey(secureEnclave: false))
        await #expect(throws: CapabilityError.self) {
            _ = try await cap.invoke(Self.ctx(.object(["challenge": .string("nothex"), "header": .string("x")])))
        }
        await #expect(throws: CapabilityError.self) {
            _ = try await cap.invoke(Self.ctx(.object(["challenge": .string(Self.challenge), "header": .string("  ")])))
        }
        let cancelling = try Self.confirmCap(FakeSigner(result: .failure(CapabilityError(.cancelled, reason: "user_cancelled", "x"))))
        do {
            _ = try await cancelling.invoke(Self.ctx(.object(["challenge": .string(Self.challenge), "header": .string("x")])))
            Issue.record("expected a cancel")
        } catch let e as CapabilityError {
            #expect(e.code == .cancelled && e.reason == "user_cancelled")
        }
    }

    @Test func confirmReasonIsFixedAroundOneLineOfHeader() {
        let r = PresenceCapabilities.confirmReason(header: "Run command\non this Mac")
        #expect(r == "approve \u{201C}Run command on this Mac\u{201D} in Psyche")
        #expect(PresenceCapabilities.confirmReason(header: String(repeating: "a", count: 500)).count <= 140)
    }
}

/// A software P-256 key standing in for the Secure Enclave: its raw representation is the "blob".
private struct SoftwareBackend: EnclaveKeyBackend {
    func create() throws -> Data { P256.Signing.PrivateKey().rawRepresentation }
    func publicKey(blob: Data) throws -> Data { try P256.Signing.PrivateKey(rawRepresentation: blob).publicKey.x963Representation }
    func sign(blob: Data, message: Data, reason: String) async throws -> Data {
        try P256.Signing.PrivateKey(rawRepresentation: blob).signature(for: message).derRepresentation
    }
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

    @Test func keepsTheKeychainKeyWhenTheBuildCanHoldIt() async throws {
        let k = PreferredPresenceKey(primary: KeyedFake(kind: .keychain), fallback: KeyedFake(kind: .enclaveFile))
        #expect(try k.publicKey().keyId == "keychain")
        #expect(k.keyKind == .keychain)
        #expect(try await k.sign(challenge: Self.challenge, reason: "r").signature == "keychain")
    }

    @Test func fallsBackOnlyOnMissingEntitlement() async throws {
        let noProfile = CapabilityError(.unavailable, reason: "missing_entitlement", "x")
        let k = PreferredPresenceKey(primary: KeyedFake(kind: .keychain, failure: noProfile), fallback: KeyedFake(kind: .enclaveFile))
        #expect(try k.publicKey().keyId == "enclave_file")
        #expect(k.keyKind == .enclaveFile)
        #expect(try await k.sign(challenge: Self.challenge, reason: "r").signature == "enclave_file")
        // Any other keychain failure is reported, never papered over with the file key.
        let locked = CapabilityError(.forbidden, reason: "interaction_not_allowed", "x")
        let other = PreferredPresenceKey(primary: KeyedFake(kind: .keychain, failure: locked), fallback: KeyedFake(kind: .enclaveFile))
        #expect(throws: CapabilityError.self) { _ = try other.publicKey() }
        #expect(other.keyKind == .keychain)
    }

    @Test func writesTheBlobFile0600InA0700FolderAndReusesIt() async throws {
        let path = Self.tempPath()
        let key = EnclaveFilePresenceKey(path: path, backend: SoftwareBackend())
        let (x963, keyId) = try key.publicKey()
        #expect(Self.mode(path) == 0o600)
        #expect(Self.mode((path as NSString).deletingLastPathComponent) == 0o700)
        // The same key on the next start, and its signature verifies against it.
        let again = EnclaveFilePresenceKey(path: path, backend: SoftwareBackend())
        #expect(try again.publicKey().keyId == keyId)
        let signed = try await again.sign(challenge: Self.challenge, reason: "r")
        #expect(signed.keyId == keyId)
        let pub = try P256.Signing.PublicKey(x963Representation: x963)
        let sig = try P256.Signing.ECDSASignature(derRepresentation: try #require(Base64URL.decode(signed.signature)))
        #expect(pub.isValidSignature(sig, for: PresenceMessage.bytes(challenge: Self.challenge)))
        #expect(key.keyKind == .enclaveFile)
    }

    @Test func tightensALooseFolderAndRefusesALooseOrLinkedFile() throws {
        let path = Self.tempPath()
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        _ = try EnclaveFilePresenceKey(path: path, backend: SoftwareBackend()).publicKey()
        #expect(Self.mode(dir) == 0o700)

        chmod(path, 0o644)
        #expect(throws: CapabilityError.self) { _ = try EnclaveFilePresenceKey(path: path, backend: SoftwareBackend()).publicKey() }

        let linked = Self.tempPath()
        try FileManager.default.createDirectory(atPath: (linked as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        symlink(path, linked)
        #expect(throws: CapabilityError.self) { _ = try EnclaveFilePresenceKey(path: linked, backend: SoftwareBackend()).publicKey() }
    }

    @Test func publicKeyCapabilityReportsTheKind() async throws {
        let key = EnclaveFilePresenceKey(path: Self.tempPath(), backend: SoftwareBackend())
        let cap = try #require(PresenceCapabilities.make(key: key).first)
        let out = try await cap.invoke(InvocationContext(invocationId: "i", capability: cap.spec.name, params: .null, approvalId: nil, emit: { _ in }))
        #expect(out.result["kind"] == .string("enclave_file"))
        let keychain = try #require(PresenceCapabilities.make(key: PresenceKey(secureEnclave: false)).first)
        let k = try await keychain.invoke(InvocationContext(invocationId: "i", capability: cap.spec.name, params: .null, approvalId: nil, emit: { _ in }))
        #expect(k.result["kind"] == .string("keychain"))
    }
}
