import CryptoKit
import Foundation
import PsycheHelperCore
import Testing

@Suite("connect signing payload")
struct SigningPayloadTests {
    // Same fixture as apps/desktop/test/signing.test.ts and apps/web/test/handshake.test.ts.
    static let nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    static let fixtureSHA256 = "724005f48718da546d4612ce25b78ff21172c0c3ae225f56774bd427e200c965"

    @Test func matchesTheTypeScriptSpecByteForByte() {
        let payload = ConnectSigning.payload(
            nonce: Self.nonce, platform: "macos", deviceFamily: "mac-helper", protocolVersion: 1,
            serverOrigin: "http://127.0.0.1:7979"
        )
        let expected = "psyche-connect-v1\n" + Self.nonce + "\n" + "macos" + "\n" + "mac-helper" + "\n" + "1" + "\n"
            + "http://127.0.0.1:7979"
        #expect(payload == Data(expected.utf8))
        let hex = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        #expect(hex == Self.fixtureSHA256)
    }

    @Test func nonceIs32BytesOfBase64URL() {
        #expect(Base64URL.decode(Self.nonce) == Data(0..<32))
        #expect(Base64URL.encode(Data(0..<32)) == Self.nonce)
    }

    @Test func deviceIdentitySignaturesVerify() throws {
        let identity = DeviceIdentity()
        #expect(Base64URL.decode(identity.publicKey)?.count == 32)
        #expect(identity.deviceId.hasPrefix("dev_") && identity.deviceId.count == 26)
        let payload = Data("hello".utf8)
        let signature = try #require(Base64URL.decode(try identity.sign(payload)))
        #expect(identity.privateKey.publicKey.isValidSignature(signature, for: payload))
    }
}
