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
            IdentityCheck.verify(challenge: c, pinnedKey: pin, dialedOrigin: dialed, devicePublicKey: Self.devicePublicKey)
        }
        #expect(check(challenge()) == nil)
        #expect(check(challenge(key: nil, signature: nil)) == .missingKey)
        #expect(check(challenge(signature: nil)) == .missingKey)
        #expect(check(challenge(), pin: Base64URL.encode(Data(repeating: 1, count: 32))) == .keyChanged)
        #expect(check(challenge(origin: "https://evil.example")) == .originMismatch)
        #expect(check(challenge(), dialed: "https://other.example") == .originMismatch)
        #expect(check(challenge(signature: "A" + Self.nodeSignature.dropFirst())) == .badSignature)
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
