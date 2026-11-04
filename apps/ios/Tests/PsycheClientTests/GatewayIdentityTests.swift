import CryptoKit
import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireConnectChallenge
import PsycheShared
import PsycheWire
import Testing

@testable import PsycheClient

/// Cross-checked against Node: the signature and hashes below were produced by `packages/protocol`'s
/// payload builders and Node's Ed25519, so a phone that verifies them verifies a real Gateway.
struct GatewayIdentityTests {
    static let nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    static let origin = "https://studio-mac.tail1234.ts.net"
    static let devicePublicKey = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"
    // Gateway test key: seed = 32 x 0x07.
    static let gatewayKey = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw"
    static let nodeSignature = "f6qufXrYpBfmPrwqA2SS9IXJPnL1OPS-O5Nr_Our7r0gVWht8xeOY033CO54B0pWz8dd2rGuCAzqkMMzgom3AQ"

    /// A self-signed P-256 certificate (openssl) and its pin as apps/gateway/src/lan/cert.ts (spkiPin) computes it.
    static let certificateDER = "MIIBizCCATCgAwIBAgIUa3qjcTwXCm3Vr4mCEF08Zsf+WHEwCgYIKoZIzj0EAwIwHDEaMBgGA1UEAwwRcHN5Y2hlLXRlc3QubG9jYWwwHhcNMjYxMTA0MjEzODQzWhcNMzYxMTAxMjEzODQzWjAcMRowGAYDVQQDDBFwc3ljaGUtdGVzdC5sb2NhbDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJGZHAP6dHusrI6lwOMVzR9MOzNlyYiU27ypTGZJFITAqU4bedzVw5CRg1jsKwZntKw7z+nJFmCzc03eF/cvIHijUDBOMB0GA1UdDgQWBBRCDHUEIpwFj265aXgU9e8YpnJGgzAPBgNVHRMBAf8EBTADAQH/MBwGA1UdEQQVMBOCEXBzeWNoZS10ZXN0LmxvY2FsMAoGCCqGSM49BAMCA0kAMEYCIQDqAF7GOuuoQtWEUtVejBB0w0d7D1SLF9iwvMksOIWKcAIhAJNwiNWMvRCrIgSpVWDhTKeqiOXO6Kh8g0+3hKEoNZwg"

    private func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    @Test func gatewayPayloadMatchesTheR1Fixture() {
        let payload = GatewaySigning.payload(nonce: Self.nonce, serverOrigin: Self.origin, devicePublicKey: Self.devicePublicKey)
        // packages/protocol/test/gateway-identity.test.ts "matches the shared fixture"
        #expect(sha(payload) == "a7614e437ff769b36ea9d4c3ee5d134314525e23ae03bdcdfe243ef437bf0d3d")
    }

    @Test func v2ConnectPayloadBindsTheGatewayKey() {
        let v2 = ConnectSigning.payload(
            nonce: Self.nonce, platform: "ios", deviceFamily: "ios", protocolVersion: 1,
            serverOrigin: Self.origin, gatewayKey: Self.gatewayKey)
        #expect(sha(v2) == "5e904f21664758f291d573aea879d9e4f24c5ce4aebe8ffa444276c59da1188d")
        let v1 = ConnectSigning.payload(nonce: Self.nonce, platform: "ios", deviceFamily: "ios", protocolVersion: 1, serverOrigin: Self.origin)
        #expect(String(decoding: v1, as: UTF8.self).hasPrefix("psyche-connect-v1\n"))
        #expect(String(decoding: v2, as: UTF8.self).hasPrefix("psyche-connect-v2\n"))
    }

    @Test func verifiesANodeSignature() {
        #expect(GatewaySigning.verify(
            signature: Self.nodeSignature, gatewayKey: Self.gatewayKey, nonce: Self.nonce,
            serverOrigin: Self.origin, devicePublicKey: Self.devicePublicKey))
    }

    @Test func rejectsEveryChangedField() {
        func ok(nonce: String = Self.nonce, origin: String = Self.origin, device: String = Self.devicePublicKey, key: String = Self.gatewayKey, sig: String = Self.nodeSignature) -> Bool {
            GatewaySigning.verify(signature: sig, gatewayKey: key, nonce: nonce, serverOrigin: origin, devicePublicKey: device)
        }
        #expect(ok())
        #expect(!ok(nonce: "B" + Self.nonce.dropFirst()))
        #expect(!ok(origin: "https://evil.example"))
        #expect(!ok(device: "J" + Self.devicePublicKey.dropFirst()))  // relayed to another device
        #expect(!ok(key: Base64URL.encode(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)))
        #expect(!ok(sig: "A" + Self.nodeSignature.dropFirst()))
        #expect(!ok(sig: "short"))
        #expect(!ok(key: "short"))
    }

    // MARK: IdentityCheck (the challenge gate)

    private func challenge(key: String? = Self.gatewayKey, signature: String? = Self.nodeSignature, origin: String = Self.origin) -> WireConnectChallenge {
        var json: [String: JSONValue] = [
            "phase": "challenge", "nonce": .string(Self.nonce), "serverOrigin": .string(origin),
            "protocolVersion": .number(1), "expiresAt": "2030-01-01T00:00:00Z",
        ]
        if let key { json["gatewayKey"] = .string(key) }
        if let signature { json["gatewaySignature"] = .string(signature) }
        return try! JSONValue.object(json).decode(as: WireConnectChallenge.self)
    }

    @Test func challengeGateAcceptsOnlyTheFullChain() {
        func check(_ c: WireConnectChallenge, pin: String = Self.gatewayKey, dialed: String = Self.origin) -> IdentityCheck.Failure? {
            let result = IdentityCheck.verify(
                challenge: c, pin: IdentityCheck.Pin(key: pin), dialedOrigin: dialed, devicePublicKey: Self.devicePublicKey,
                certificate: .trusted)
            if case .failure(let failure) = result { return failure }
            return nil
        }
        #expect(check(challenge()) == nil)
        #expect(check(challenge(key: nil, signature: nil)) == .missingKey)
        #expect(check(challenge(signature: nil)) == .missingKey)
        #expect(check(challenge(), pin: Base64URL.encode(Data(repeating: 1, count: 32))) == .keyChanged)
        #expect(check(challenge(origin: "https://evil.example")) == .originMismatch)
        #expect(check(challenge(), dialed: "https://other.example") == .originMismatch)
        #expect(check(challenge(signature: "A" + Self.nodeSignature.dropFirst())) == .badSignature)
    }

    @Test func theFingerprintPinsTheKeyUntilOneIsStored() {
        let fingerprint = PairingLink.fingerprint(ofKey: Self.gatewayKey)
        // packages/protocol: identityFingerprint(key) = sha256:<hex of SHA-256 of the raw key>
        #expect(fingerprint == "sha256:" + sha(Base64URL.decode(Self.gatewayKey)!))
        func check(_ fp: String?) -> Result<IdentityCheck.Proven, IdentityCheck.Failure> {
            IdentityCheck.verify(
                challenge: challenge(), pin: IdentityCheck.Pin(fingerprint: fp), dialedOrigin: Self.origin,
                devicePublicKey: Self.devicePublicKey, certificate: .trusted)
        }
        #expect(check(fingerprint) == .success(IdentityCheck.Proven(key: Self.gatewayKey, certSPKI: nil)))
        #expect(check("sha256:" + String(repeating: "0", count: 64)) == .failure(.keyChanged))
        #expect(check(nil) == .failure(.keyChanged))  // nothing pinned at all fails closed
    }

    // MARK: LAN certificate binding (Node vectors)

    @Test func lanCertPayloadAndSignatureMatchNode() {
        let spki = "ZGVhZGJlZWZkZWFkYmVlZmRlYWRiZWVmZGVhZGJlZWY"
        let payload = LanCertSigning.payload(nonce: Self.nonce, serverOrigin: Self.origin, devicePublicKey: Self.devicePublicKey, spki: spki)
        #expect(sha(payload) == "4267562373e11a5e45ee99140714d13dde4299db41e7f118e8d3f11d94fd2843")
        #expect(LanCertSigning.verify(
            signature: "wKuke6KVuOErndLQs0nU4ojRxoyDb_xmOVhdPRVqVMUUoke6pmUACqUptRRLgOur7Z4MbOYSy3x4d1ICd34DBQ", gatewayKey: Self.gatewayKey, nonce: Self.nonce, serverOrigin: Self.origin,
            devicePublicKey: Self.devicePublicKey, spki: spki))
        #expect(!LanCertSigning.verify(
            signature: "wKuke6KVuOErndLQs0nU4ojRxoyDb_xmOVhdPRVqVMUUoke6pmUACqUptRRLgOur7Z4MbOYSy3x4d1ICd34DBQ", gatewayKey: Self.gatewayKey, nonce: Self.nonce, serverOrigin: Self.origin,
            devicePublicKey: Self.devicePublicKey, spki: "A" + spki.dropFirst()))
    }

    // MARK: Certificate pin (Node vector)

    @Test func certificatePinMatchesTheGatewaysSpkiPin() throws {
        let der = try #require(Data(base64Encoded: GatewayIdentityTests.certificateDER))
        #expect(CertificatePin.spki(ofCertificate: der) == "y-qIuIwzdHBoooNoUxd1h6ejl3Yw105d7iq5eJ1lK04")
        #expect(CertificatePin.spki(ofCertificate: Data("not a certificate".utf8)) == nil)
        #expect(CertificatePin.spki(ofCertificate: der.prefix(40)) == nil)
    }

    // MARK: Device key store

    @Test func deviceKeyIsCreatedOnceAndStable() async throws {
        let secrets = MemorySecretStore()
        let first = try await DeviceIdentityStore(store: secrets).identity()
        let again = try await DeviceIdentityStore(store: secrets).identity()
        #expect(first.publicKey == again.publicKey)
        #expect(first.deviceId.hasPrefix("dev_"))
    }

    @Test func wipeMakesANewKey() async throws {
        let store = DeviceIdentityStore(store: MemorySecretStore())
        let before = try await store.identity().publicKey
        try await store.wipe()
        #expect(try await store.identity().publicKey != before)
    }
}
