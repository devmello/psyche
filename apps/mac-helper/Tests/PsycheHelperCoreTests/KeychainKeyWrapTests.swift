import Foundation
import PsycheHelperCore
import Testing

@Suite("KeyWrap AES-256-GCM v1")
struct KeychainKeyWrapTests {
    let dek = Data((0..<32).map { UInt8($0) })
    let kek = KeyWrap.generateKEK()

    @Test func roundTrips() throws {
        let blob = try KeyWrap.wrap(dek: dek, kek: kek, slot: "vault.main")
        #expect(blob.count == KeyWrap.wrappedByteCount)
        #expect(blob.count == 61)
        #expect(blob.first == 1)
        #expect(try KeyWrap.unwrap(blob, kek: kek, slot: "vault.main") == dek)
    }

    @Test func roundTripsThroughBase64URL() throws {
        let wrapped = try KeyWrap.wrapBase64URL(dek: dek, kek: kek, slot: "s")
        #expect(!wrapped.contains("=") && !wrapped.contains("+") && !wrapped.contains("/"))
        #expect(try KeyWrap.unwrapBase64URL(wrapped, kek: kek, slot: "s") == dek)
    }

    @Test func usesAFreshNonceEachTime() throws {
        let a = try KeyWrap.wrap(dek: dek, kek: kek, slot: "s")
        let b = try KeyWrap.wrap(dek: dek, kek: kek, slot: "s")
        #expect(a != b)
        #expect(a.subdata(in: 1..<13) != b.subdata(in: 1..<13))
    }

    @Test func generatedKEKsAre32RandomBytes() {
        let a = KeyWrap.generateKEK()
        #expect(a.count == 32)
        #expect(a != KeyWrap.generateKEK())
    }

    /// Nonce (1…12), ciphertext (13…44) and tag (45…60); the version byte is covered below.
    @Test(arguments: [1, 12, 13, 44, 45, 60])
    func detectsTamperingAtEveryRegion(offset: Int) throws {
        var blob = try KeyWrap.wrap(dek: dek, kek: kek, slot: "s")
        blob[offset] ^= 0x01
        #expect(throws: KeyWrapError.authenticationFailed) { try KeyWrap.unwrap(blob, kek: kek, slot: "s") }
    }

    @Test func rejectsAWrongSlot() throws {
        let blob = try KeyWrap.wrap(dek: dek, kek: kek, slot: "vault.main")
        #expect(throws: KeyWrapError.authenticationFailed) { try KeyWrap.unwrap(blob, kek: kek, slot: "vault.other") }
        #expect(throws: KeyWrapError.authenticationFailed) { try KeyWrap.unwrap(blob, kek: kek, slot: "") }
    }

    @Test func rejectsAWrongKEK() throws {
        let blob = try KeyWrap.wrap(dek: dek, kek: kek, slot: "s")
        #expect(throws: KeyWrapError.authenticationFailed) { try KeyWrap.unwrap(blob, kek: KeyWrap.generateKEK(), slot: "s") }
    }

    @Test func rejectsBadKeySizes() {
        #expect(throws: KeyWrapError.badKeySize(field: "dek", byteCount: 16)) {
            try KeyWrap.wrap(dek: Data(count: 16), kek: kek, slot: "s")
        }
        #expect(throws: KeyWrapError.badKeySize(field: "dek", byteCount: 33)) {
            try KeyWrap.wrap(dek: Data(count: 33), kek: kek, slot: "s")
        }
        #expect(throws: KeyWrapError.badKeySize(field: "kek", byteCount: 31)) {
            try KeyWrap.wrap(dek: dek, kek: Data(count: 31), slot: "s")
        }
        #expect(throws: KeyWrapError.badKeySize(field: "kek", byteCount: 0)) {
            try KeyWrap.unwrap(Data(count: 61), kek: Data(), slot: "s")
        }
    }

    @Test func rejectsMalformedBlobs() throws {
        let blob = try KeyWrap.wrap(dek: dek, kek: kek, slot: "s")
        #expect(throws: KeyWrapError.malformed) { try KeyWrap.unwrap(Data(), kek: kek, slot: "s") }
        #expect(throws: KeyWrapError.malformed) { try KeyWrap.unwrap(blob.prefix(60), kek: kek, slot: "s") }
        #expect(throws: KeyWrapError.malformed) { try KeyWrap.unwrap(blob + Data([0]), kek: kek, slot: "s") }
        #expect(throws: KeyWrapError.malformed) { try KeyWrap.unwrapBase64URL("not base64!", kek: kek, slot: "s") }
    }

    @Test func rejectsUnknownVersions() throws {
        var blob = try KeyWrap.wrap(dek: dek, kek: kek, slot: "s")
        blob[0] = 2
        #expect(throws: KeyWrapError.unsupportedVersion(2)) { try KeyWrap.unwrap(blob, kek: kek, slot: "s") }
    }

    @Test func errorsMapToCapabilityErrorsWithoutKeyMaterial() throws {
        #expect(KeyWrapError.authenticationFailed.capabilityError.code == .invalidParams)
        #expect(KeyWrapError.authenticationFailed.capabilityError.reason == "unwrap_failed")
        #expect(KeyWrapError.malformed.capabilityError.reason == "wrapped_malformed")
        #expect(KeyWrapError.unsupportedVersion(9).capabilityError.reason == "wrapped_version")
        #expect(KeyWrapError.badKeySize(field: "dek", byteCount: 3).capabilityError.reason == "bad_key_size")
    }
}
