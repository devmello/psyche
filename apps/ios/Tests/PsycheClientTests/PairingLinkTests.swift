import Foundation
import PsycheShared
import PsycheWire
import Testing

@testable import PsycheClient

/// Mirrors `packages/protocol/test/pairing-link.test.ts` so the phone and the Gateway agree on what a link is.
struct PairingLinkTests {
    // Test values built from byte sequences: not secrets.
    static func bytes(_ start: UInt8) -> String {
        Base64URL.encode(Data((0..<32).map { start &+ UInt8($0) }))
    }
    static let key = bytes(32)
    static let token = bytes(0)

    static func link(_ fields: [String: Any]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
        return PairingLink.prefix + Base64URL.encode(data)
    }

    static func fields(url: String = "https://studio-mac.tail1234.ts.net", host: String = "studio-mac") -> [String: Any] {
        ["gatewayUrl": url, "gatewayIdentityKey": key, "setupToken": token, "hostName": host]
    }

    @Test func parsesAGoodLinkAndIgnoresSurroundingWhitespace() throws {
        let text = Self.link(Self.fields(host: "Studio Mac — Café"))
        for input in [text, "  \(text)\n"] {
            let parsed = try PairingLink.parse(input)
            #expect(parsed.gatewayURL == "https://studio-mac.tail1234.ts.net")
            #expect(parsed.gatewayIdentityKey == Self.key)
            #expect(parsed.setupToken == Self.token)
            #expect(parsed.hostName == "Studio Mac — Café")
            #expect(parsed.host == "studio-mac.tail1234.ts.net")
            #expect(parsed.transport == .tailscale)
        }
    }

    @Test func theFixedFixtureParsesTheSameBytesTheGatewayEncodes() throws {
        // The exact JSON, in this key order, that encodePairingLink writes for the fixture.
        let json = "{\"gatewayUrl\":\"https://studio-mac.tail1234.ts.net\",\"gatewayIdentityKey\":\"\(Self.key)\",\"setupToken\":\"\(Self.token)\",\"hostName\":\"studio-mac\"}"
        let parsed = try PairingLink.parse(PairingLink.prefix + Base64URL.encode(Data(json.utf8)))
        #expect(parsed.hostName == "studio-mac")
        #expect(parsed.endpoint.url == "https://studio-mac.tail1234.ts.net")
        #expect(parsed.endpoint.identityKey == Self.key)
    }

    @Test func refusesAnythingThatIsNotAWellFormedV1Link() {
        let good = Self.fields()
        func with(_ k: String, _ v: Any) -> String { var f = good; f[k] = v; return Self.link(f) }
        var missingToken = good
        missingToken["setupToken"] = nil
        let body = String(Self.link(good).dropFirst(PairingLink.prefix.count))
        let bad: [String] = [
            "", "psyche-pair:v1:abc", "psyche-pair:v2:" + body, "https://studio-mac.tail1234.ts.net",
            "https://x.example/?l=" + Self.link(good), Self.link(missingToken),
            with("setupToken", "short"), with("gatewayIdentityKey", "short"),
            with("hostName", ""), with("hostName", "a\nb"), with("hostName", "studio\u{202E}mac"),
            with("hostName", String(repeating: "x", count: 129)),
            with("gatewayUrl", "http://studio-mac.tail1234.ts.net"),
            with("gatewayUrl", "https://studio-mac.tail1234.ts.net/chat"),
            with("gatewayUrl", "https://studio-mac.tail1234.ts.net/?gatewayUrl=x"),
            with("gatewayUrl", "https://studio-mac.tail1234.ts.net/#frag"),
            with("gatewayUrl", "https://o:pw@studio-mac.tail1234.ts.net"),
            with("gatewayUrl", "https://studio-mac.tail1234.ts.net@evil.example"),
            with("gatewayUrl", "ftp://studio-mac.tail1234.ts.net"),
            with("gatewayUrl", "https://studio mac.example"),
            "psyche-pair:v1:" + String(repeating: "A", count: 4000), "psyche-pair:v1:!!!",
            PairingLink.prefix + Base64URL.encode(Data("\"string\"".utf8)),
            PairingLink.prefix + Base64URL.encode(Data("[1]".utf8)),
        ]
        for input in bad {
            #expect(throws: PairingLink.ParseError.self, "\(input.prefix(50))") { _ = try PairingLink.parse(input) }
        }
    }

    @Test func ignoresUnknownFieldsSoALaterRevisionStillParses() throws {
        var f = Self.fields()
        f["spkiPins"] = ["x"]
        #expect(try PairingLink.parse(Self.link(f)).hostName == "studio-mac")
    }

    @Test func allowsHTTPOnlyToExactlyLocalhost127AndLoopbackV6() throws {
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            #expect(try PairingLink.origin("http://\(host):7979") == "http://\(host):7979")
        }
        for host in ["foo.localhost", "x.localhost", "a.b.localhost", "localhost.example.com", "127.0.0.2", "192.168.1.20"] {
            #expect(throws: PairingLink.ParseError.self, "\(host)") { _ = try PairingLink.origin("http://\(host):7979") }
        }
        // https needs no exemption for any of them.
        #expect(try PairingLink.origin("https://foo.localhost") == "https://foo.localhost")
    }

    @Test func normalizesTheOrigin() throws {
        #expect(try PairingLink.origin("https://Studio-Mac.local:7979/") == "https://studio-mac.local:7979")
        #expect(try PairingLink.origin("https://studio-mac.example:443") == "https://studio-mac.example")
    }

    @Test func refusesAHostNameThatCouldHideOrReshapeTheSentence() {
        let hidden = [
            "a\u{200D}b", "a\u{200E}b", "a\u{2028}b", "a\u{2029}b", "a\u{0085}b", "a\u{00AD}b",
            "a\u{115F}b", "a\u{3164}b", "a\u{E0041}b", "a\u{2066}b", "a\u{202E}b",
        ]
        for name in hidden {
            #expect(throws: PairingLink.ParseError.self, "\(name.unicodeScalars.map(\.value))") {
                _ = try PairingLink.parse(Self.link(Self.fields(host: name)))
            }
        }
        #expect((try? PairingLink.parse(Self.link(Self.fields(host: "Café 日本")))) != nil)
    }

    @Test func fingerprintIsTheFirstSixBytesOfSHA256Grouped() {
        let fp = PairingLink.fingerprint(ofKey: Self.key)
        #expect(fp.count == 14)  // "AAAA BBBB CCCC"
        #expect(fp.split(separator: " ").count == 3)
        #expect(fp == fp.uppercased())
    }

    @Test func transportFollowsTheHost() throws {
        #expect(try PairingLink.parse(Self.link(Self.fields(url: "https://studio-mac.local:7979"))).transport == .lan)
        #expect(try PairingLink.parse(Self.link(Self.fields())).transport == .tailscale)
    }
}
