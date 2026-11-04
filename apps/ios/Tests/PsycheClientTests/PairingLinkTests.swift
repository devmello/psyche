import Foundation
import PsycheShared
import PsycheWire
import Testing

@testable import PsycheClient

/// Mirrors `packages/protocol/test/pairing-link.test.ts` so the phone and the Gateway agree on what a link is.
struct PairingLinkTests {
    // Test values, not secrets. The same ones the TypeScript test uses.
    static let fingerprint = "sha256:" + String(repeating: "ab", count: 32)
    static let token = "pst_" + Base64URL.encode(Data(repeating: 7, count: 32))

    static func link(_ fields: [String: Any]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
        return PairingLink.prefix + Base64URL.encode(data)
    }

    static func fields(url: String = "https://studio-mac.tail1234.ts.net", host: String = "Studio Mac") -> [String: Any] {
        ["gatewayUrl": url, "gatewayFingerprint": fingerprint, "setupToken": token, "hostName": host]
    }

    /// The failure `parse` throws, spelled as the TypeScript test spells `problem()`.
    static func problem(_ text: String) -> String? {
        do { _ = try PairingLink.parse(text) } catch let error as PairingLink.ParseError {
            switch error {
            case .notAPairingLink: return "not_a_pairing_link"
            case .unsupportedVersion: return "unsupported_version"
            case .damaged: return "malformed"
            case .extraField(let f): return "extra_fields:\(f)"
            case .badField(let f): return "bad_field:\(f)"
            case .badGatewayURL: return "bad_field:gatewayUrl"
            }
        } catch { return "other" }
        return nil
    }

    @Test func parsesTheFourFieldsAndIgnoresSurroundingWhitespace() throws {
        let text = Self.link(Self.fields(host: "Studio Mac de María"))
        for input in [text, "  \(text)\n"] {
            let parsed = try PairingLink.parse(input)
            #expect(parsed.gatewayURL == "https://studio-mac.tail1234.ts.net")
            #expect(parsed.gatewayFingerprint == Self.fingerprint)
            #expect(parsed.setupToken == Self.token)
            #expect(parsed.hostName == "Studio Mac de María")
            #expect(parsed.host == "studio-mac.tail1234.ts.net")
            #expect(parsed.transport == .tailscale)
        }
    }

    @Test func theEndpointIsPinnedByTheFingerprintUntilAKeyIsProven() throws {
        let parsed = try PairingLink.parse(Self.link(Self.fields()))
        #expect(parsed.endpoint.linkFingerprint == Self.fingerprint)
        #expect(parsed.endpoint.identityKey.isEmpty)
        #expect(parsed.endpoint.url == "https://studio-mac.tail1234.ts.net")
        #expect(parsed.endpoint.fingerprint == "ABAB ABAB ABAB")
        #expect(parsed.endpoint.lanCertSpki == nil)
    }

    @Test func matchesTheSchemeWithoutRegardToCaseAndNothingElse() throws {
        let text = Self.link(Self.fields()).replacingOccurrences(of: "psyche-pair:", with: "Psyche-Pair:")
        #expect(try PairingLink.parse(text).hostName == "Studio Mac")
        #expect(Self.problem(text.replacingOccurrences(of: ":v1:", with: ":V1:")) == "unsupported_version")
    }

    @Test func rejectsTextThatIsNotAPairingLinkAndOtherVersions() {
        let body = String(Self.link(Self.fields()).dropFirst(PairingLink.prefix.count))
        #expect(Self.problem("https://studio-mac.tail1234.ts.net") == "not_a_pairing_link")
        #expect(Self.problem("psyche://chat") == "not_a_pairing_link")
        #expect(Self.problem("") == "not_a_pairing_link")
        #expect(Self.problem("psyche-pair:") == "malformed")
        #expect(Self.problem("psyche-pair:v1") == "malformed")
        #expect(Self.problem("psyche-pair:v2:" + body) == "unsupported_version")
        #expect(Self.problem("psyche-pair::" + body) == "unsupported_version")
        // A link wrapped in a URL some page chose is not a pairing link.
        #expect(Self.problem("https://x.example/?l=" + Self.link(Self.fields())) == "not_a_pairing_link")
    }

    @Test func rejectsBodiesThatAreNotBase64URLJSONObjects() {
        func b64(_ text: String) -> String { PairingLink.prefix + Base64URL.encode(Data(text.utf8)) }
        let good = String(Self.link(Self.fields()).dropFirst(PairingLink.prefix.count))
        #expect(Self.problem(PairingLink.prefix) == "malformed")
        #expect(Self.problem(PairingLink.prefix + "not base64!") == "malformed")
        #expect(Self.problem(PairingLink.prefix + good + "=") == "malformed")
        #expect(Self.problem(b64("{nope")) == "malformed")
        for body in ["null", "7", "\"text\"", "[{}]", "[]", "true"] { #expect(Self.problem(b64(body)) == "malformed", "\(body)") }
        // Invalid UTF-8 is not silently repaired.
        #expect(Self.problem(PairingLink.prefix + Base64URL.encode(Data([0x7B, 0xFF, 0x7D]))) == "malformed")
        #expect(Self.problem(PairingLink.prefix + String(repeating: "A", count: 3000)) == "malformed")
        // One character more than a multiple of four cannot be base64.
        #expect(Self.problem(PairingLink.prefix + "AAAAA") == "malformed")
    }

    @Test func rejectsAnyExtraFieldIncludingOnesThatLookHarmless() {
        var f = Self.fields()
        f["spkiPins"] = [String]()
        #expect(Self.problem(Self.link(f)) == "extra_fields:spkiPins")
        f = Self.fields()
        f["scopes"] = ["operator.admin"]
        #expect(Self.problem(Self.link(f)) == "extra_fields:scopes")
        f = Self.fields()
        f["gatewayIdentityKey"] = "x"  // the old shape of this phone's own parser
        #expect(Self.problem(Self.link(f)) == "extra_fields:gatewayIdentityKey")
        let proto = PairingLink.prefix + Base64URL.encode(Data(#"{"__proto__":{},"gatewayUrl":"x"}"#.utf8))
        #expect(Self.problem(proto) == "extra_fields:__proto__")
    }

    @Test func rejectsAMissingFieldOrOneOfTheWrongType() {
        for field in ["gatewayUrl", "gatewayFingerprint", "setupToken", "hostName"] {
            var gone = Self.fields()
            gone[field] = nil
            #expect(Self.problem(Self.link(gone)) == "bad_field:\(field)", "\(field) missing")
            for wrong: Any in [7, NSNull()] {
                var f = Self.fields()
                f[field] = wrong
                #expect(Self.problem(Self.link(f)) == "bad_field:\(field)", "\(field) = \(wrong)")
            }
        }
    }

    @Test func rejectsValuesOutsideTheirShape() {
        func with(_ k: String, _ v: String) -> String? {
            var f = Self.fields()
            f[k] = v
            return Self.problem(Self.link(f))
        }
        let token = Self.token
        #expect(with("gatewayFingerprint", "sha256:abc") == "bad_field:gatewayFingerprint")
        #expect(with("gatewayFingerprint", "sha256:" + String(repeating: "AB", count: 32)) == "bad_field:gatewayFingerprint")
        #expect(with("gatewayFingerprint", "md5:" + String(repeating: "ab", count: 32)) == "bad_field:gatewayFingerprint")
        #expect(with("setupToken", "pst_short") == "bad_field:setupToken")
        #expect(with("setupToken", token.replacingOccurrences(of: "pst_", with: "tok_")) == "bad_field:setupToken")
        #expect(with("setupToken", token + "A") == "bad_field:setupToken")
        #expect(with("gatewayUrl", "") == "bad_field:gatewayUrl")
        #expect(with("gatewayUrl", "https://" + String(repeating: "a", count: 400) + ".ts.net") == "bad_field:gatewayUrl")
        #expect(with("gatewayUrl", "https://studio mac.ts.net") == "bad_field:gatewayUrl")
        #expect(with("hostName", "   ") == "bad_field:hostName")
        #expect(with("hostName", String(repeating: "a", count: 65)) == "bad_field:hostName")
        // Control and bidirectional-override characters cannot reshape a dialog.
        #expect(with("hostName", "Studio\nMac") == "bad_field:hostName")
        #expect(with("hostName", "Studio\u{202E}Mac") == "bad_field:hostName")
        #expect(with("hostName", String(repeating: "a", count: 64)) == nil)
    }

    @Test func acceptsOnlyAnHTTPSOriginForAHost() throws {
        func url(_ u: String) -> String? {
            var f = Self.fields()
            f["gatewayUrl"] = u
            return Self.problem(Self.link(f))
        }
        for bad in [
            "http://studio-mac.tail1234.ts.net", "http://127.0.0.1:7979", "http://localhost:7979",
            "https://localhost", "https://127.0.0.1:7979", "https://127.1", "https://[::1]", "https://LOCALHOST",
            "https://user:pw@studio-mac.tail1234.ts.net", "https://studio-mac.tail1234.ts.net@evil.example",
            "https://studio-mac.tail1234.ts.net/chat", "https://studio-mac.tail1234.ts.net/?a=1",
            "https://studio-mac.tail1234.ts.net?", "https://studio-mac.tail1234.ts.net/#x",
            "ftp://studio-mac.tail1234.ts.net", "studio-mac.tail1234.ts.net", "https://studio-mac.tail1234.ts.net\\x",
        ] {
            #expect(url(bad) == "bad_field:gatewayUrl", "\(bad)")
        }
        var f = Self.fields()
        f["gatewayUrl"] = "https://studio-mac.tail1234.ts.net:8443/"
        #expect(try PairingLink.parse(Self.link(f)).gatewayURL == "https://studio-mac.tail1234.ts.net:8443")
    }

    @Test func normalizesTheOrigin() throws {
        #expect(try PairingLink.origin("https://Studio-Mac.local:7979/") == "https://studio-mac.local:7979")
        #expect(try PairingLink.origin("https://studio-mac.example:443") == "https://studio-mac.example")
        #expect(try PairingLink.origin("https://192.168.1.20:7979") == "https://192.168.1.20:7979")
    }

    @Test func stripsInvisibleCharactersFromTheHostNameAndRefusesOneThatIsEmptyAfter() throws {
        var f = Self.fields()
        f["hostName"] = "Stu\u{2060}dio\u{3164} Mac\u{FEFF}"
        #expect(try PairingLink.parse(Self.link(f)).hostName == "Studio Mac")
        f["hostName"] = "  Studio    Mac  "
        #expect(try PairingLink.parse(Self.link(f)).hostName == "Studio Mac")
        for name in ["\u{3164}", "\u{115F}\u{1160}", "\u{2060}\u{FEFF}", "\u{E0041}"] {
            f["hostName"] = name
            #expect(Self.problem(Self.link(f)) == "bad_field:hostName", "\(name.unicodeScalars.map(\.value))")
        }
        // Bidi and zero-width marks are refused outright rather than stripped.
        for name in ["a\u{200D}b", "a\u{200E}b", "a\u{2028}b", "a\u{0085}b", "a\u{2066}b", "a\u{202E}b"] {
            f["hostName"] = name
            #expect(Self.problem(Self.link(f)) == "bad_field:hostName", "\(name.unicodeScalars.map(\.value))")
        }
    }

    @Test func fingerprintDisplayIsTheFirstSixBytesGrouped() throws {
        let fp = PairingLink.grouped(fingerprint: "sha256:7f3a91c2e04b" + String(repeating: "0", count: 52))
        #expect(fp == "7F3A 91C2 E04B")
        // The fingerprint of a key is the hash of its raw bytes, as `identityFingerprint` in the Gateway writes it.
        let key = Base64URL.encode(Data(repeating: 7, count: 32))
        #expect(PairingLink.fingerprint(ofKey: key)?.hasPrefix("sha256:") == true)
        #expect(PairingLink.fingerprint(ofKey: key)?.count == 71)
        #expect(PairingLink.fingerprint(ofKey: "short") == nil)
    }

    @Test func transportFollowsTheHost() throws {
        #expect(try PairingLink.parse(Self.link(Self.fields(url: "https://studio-mac.local:7979"))).transport == .lan)
        #expect(try PairingLink.parse(Self.link(Self.fields())).transport == .tailscale)
    }

    @Test func isShortEnoughForAQRCodeAPhoneCanScan() {
        #expect(Self.link(Self.fields(host: "studio-mac")).count < 450)
    }
}
