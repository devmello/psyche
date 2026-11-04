import CryptoKit
import Foundation
import PsycheWire

/// The pin of a certificate as the Gateway computes it (`spkiPin` in `apps/gateway/src/lan/cert.ts`): the SHA-256,
/// base64url, of the certificate's SubjectPublicKeyInfo DER. The SPKI is cut out of the certificate bytes
/// rather than rebuilt from a key object, so the hash covers exactly what the Gateway hashed whatever the key type.
public enum CertificatePin {
    /// `spki` of an X.509 certificate in DER, or nil when the bytes are not one.
    public static func spki(ofCertificate der: Data) -> String? {
        guard let spki = spkiBytes(ofCertificate: der) else { return nil }
        return Base64URL.encode(Data(SHA256.hash(data: spki)))
    }

    /// Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version?, serial, signature, issuer, validity,
    /// subject, subjectPublicKeyInfo, ... }, ... }
    static func spkiBytes(ofCertificate der: Data) -> Data? {
        let bytes = [UInt8](der)
        guard let certificate = element(in: bytes, at: 0), certificate.tag == 0x30,
              let tbs = element(in: bytes, at: certificate.contentStart), tbs.tag == 0x30
        else { return nil }
        var cursor = tbs.contentStart
        guard var next = element(in: bytes, at: cursor) else { return nil }
        if next.tag == 0xA0 {  // explicit version
            cursor = next.end
            guard let after = element(in: bytes, at: cursor) else { return nil }
            next = after
        }
        // serial, signature, issuer, validity, subject
        for _ in 0..<5 {
            guard next.end <= tbs.end, let after = element(in: bytes, at: next.end) else { return nil }
            next = after
        }
        guard next.tag == 0x30, next.end <= tbs.end else { return nil }
        return Data(bytes[next.start..<next.end])
    }

    private struct Element {
        var tag: UInt8
        var start: Int
        var contentStart: Int
        var end: Int
    }

    /// One DER TLV at `offset`; definite lengths only.
    private static func element(in bytes: [UInt8], at offset: Int) -> Element? {
        guard offset >= 0, offset + 2 <= bytes.count else { return nil }
        let tag = bytes[offset]
        var length = Int(bytes[offset + 1])
        var contentStart = offset + 2
        if length & 0x80 != 0 {
            let count = length & 0x7F
            guard count >= 1, count <= 4, contentStart + count <= bytes.count else { return nil }
            length = 0
            for i in 0..<count { length = (length << 8) | Int(bytes[contentStart + i]) }
            contentStart += count
        }
        let end = contentStart + length
        guard length >= 0, end <= bytes.count else { return nil }
        return Element(tag: tag, start: offset, contentStart: contentStart, end: end)
    }
}
