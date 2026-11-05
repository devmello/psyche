import CryptoKit
import Foundation
import PsycheShared
import PsycheWire

/// A parsed `psyche-pair:v1:<base64url JSON>` link. The rules mirror `packages/protocol/src/pairing-link.ts`
/// (remote-gateway design §3.4): exactly four string fields, no others; the Gateway is named by the
/// `sha256:` fingerprint of its identity key, not by the key itself. The link is read only by the in-app
/// scanner or the paste field and is never a URL handler (CVE-2026-25253), so the Gateway address always
/// comes from a person pointing the camera at a code or pasting one.
public struct PairingLink: Equatable, Sendable {
    public static let prefix = "psyche-pair:v1:"

    /// `https://host[:port]`, normalized: no credentials, path, query or fragment, and never loopback.
    public let gatewayURL: String
    /// `sha256:<64 lowercase hex>` of the Gateway's raw identity key. The phone pins this until the first
    /// connect proves a key that hashes to it, then pins the key.
    public let gatewayFingerprint: String
    /// `pst_` + 43 base64url characters. Single use, ten minutes. Sent once, in `connect.verify`, after the
    /// Gateway's key was checked against `gatewayFingerprint`.
    public let setupToken: String
    /// The Host's name with invisible characters removed, as the confirm screen shows it.
    public let hostName: String

    public enum ParseError: Error, Equatable, LocalizedError {
        case notAPairingLink
        case unsupportedVersion
        case damaged
        case extraField(String)
        case badField(String)
        case badGatewayURL(String)

        public var errorDescription: String? {
            switch self {
            case .notAPairingLink: "That isn't a Psyche pairing code. Open Settings → Server & remote access → Pair another computer on your Mac."
            case .unsupportedVersion: "That pairing code is from a newer Psyche. Update this app, or make a new code on your Mac."
            case .damaged: "That pairing code is damaged. Make a new one on your Mac."
            case .extraField, .badField: "That pairing code isn't valid. Make a new one on your Mac."
            case .badGatewayURL(let why): "That pairing code points somewhere Psyche won't connect (\(why))."
            }
        }
    }

    #if DEBUG
    /// Debug builds only: a link to a development Gateway on this Mac's loopback (`http://127.0.0.1:<port>`),
    /// which real links never name. Used by `-psycheDevPair` to run the app against
    /// `tests/integration/ios-gateway/serve.ts` on the simulator. Release builds don't contain it.
    public static func development(origin: String, fingerprint: String, setupToken: String) -> PairingLink? {
        guard let url = URL(string: origin), let host = url.host, isLoopback(host), isFingerprint(fingerprint),
            isSetupToken(setupToken)
        else { return nil }
        return PairingLink(
            gatewayURL: origin, gatewayFingerprint: fingerprint, setupToken: setupToken, hostName: "Development Gateway")
    }
    #endif

    private static let maxLinkChars = 2048
    private static let maxURLChars = 300
    private static let maxHostName = 64
    private static let fields: Set<String> = ["gatewayUrl", "gatewayFingerprint", "setupToken", "hostName"]

    public static func parse(_ text: String) throws -> PairingLink {
        let link = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard link.utf16.count <= maxLinkChars else { throw ParseError.damaged }
        // The scheme is matched without regard to case (an OS may lower-case a URL it hands over); the rest is exact.
        guard link.lowercased().hasPrefix("psyche-pair:") else { throw ParseError.notAPairingLink }
        let rest = String(link.dropFirst("psyche-pair:".count))
        guard let colon = rest.firstIndex(of: ":") else { throw ParseError.damaged }
        guard rest[..<colon] == "v1" else { throw ParseError.unsupportedVersion }
        let body = String(rest[rest.index(after: colon)...])
        guard isBase64URL(body), body.utf8.count % 4 != 1, let data = Base64URL.decode(body),
              String(data: data, encoding: .utf8) != nil,
              let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any]
        else { throw ParseError.damaged }
        if let extra = object.keys.sorted().first(where: { !fields.contains($0) }) { throw ParseError.extraField(extra) }
        func field(_ key: String) throws -> String {
            guard let value = object[key] as? String else { throw ParseError.badField(key) }
            return value
        }
        let url = try field("gatewayUrl"), fingerprint = try field("gatewayFingerprint")
        let token = try field("setupToken"), host = try field("hostName")
        guard isFingerprint(fingerprint) else { throw ParseError.badField("gatewayFingerprint") }
        guard isSetupToken(token) else { throw ParseError.badField("setupToken") }
        guard let cleaned = cleanHostName(host) else { throw ParseError.badField("hostName") }
        guard url.utf16.count <= maxURLChars else { throw ParseError.badGatewayURL("too long") }
        return PairingLink(
            gatewayURL: try origin(url), gatewayFingerprint: fingerprint, setupToken: token, hostName: cleaned)
    }

    /// `sha256:` and 64 lowercase hex characters.
    static func isFingerprint(_ text: String) -> Bool {
        guard text.hasPrefix("sha256:") else { return false }
        let hex = text.dropFirst("sha256:".count)
        return hex.utf8.count == 64 && hex.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    /// `pst_` and 43 base64url characters.
    static func isSetupToken(_ text: String) -> Bool {
        text.hasPrefix("pst_") && text.utf8.count == 4 + 43 && isBase64URL(String(text.dropFirst(4)))
    }

    /// The fingerprint a Gateway key has in a link: `sha256:` and the hex SHA-256 of the raw 32 bytes.
    public static func fingerprint(ofKey key: String) -> String? {
        guard let raw = Base64URL.decode(key), raw.count == 32 else { return nil }
        return "sha256:" + SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
    }

    private static func isBase64URL(_ text: String) -> Bool {
        !text.isEmpty && text.utf8.allSatisfy {
            ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D || $0 == 0x5F
        }
    }

    /// A host name for a dialog, as `cleanHostName` and `checkPayload` in `pairing-link.ts` treat it: refused when
    /// longer than 64 UTF-16 units or when it holds a control, bidi mark or override, zero-width or separator
    /// character; otherwise invisible and format characters (and the Hangul fillers that render blank) are removed,
    /// white space is collapsed, and a name that is empty after that is refused.
    static func cleanHostName(_ name: String) -> String? {
        guard name.utf16.count <= maxHostName else { return nil }
        var kept = String.UnicodeScalarView()
        for scalar in name.unicodeScalars {
            switch scalar.value {
            case 0x00...0x1F, 0x7F...0x9F, 0x200B...0x200F, 0x2028...0x202E, 0x2066...0x2069: return nil
            case 0x3164, 0x115F, 0x1160: continue
            default: break
            }
            if scalar.properties.generalCategory == .format || scalar.properties.isDefaultIgnorableCodePoint { continue }
            kept.append(scalar)
        }
        let words = String(kept).split(whereSeparator: { $0.isWhitespace })
        let cleaned = words.joined(separator: " ")
        return cleaned.isEmpty ? nil : cleaned
    }

    /// Validates a Gateway origin and returns it normalized (lowercase host, default port dropped). Main's
    /// `isLinkOrigin`: https only, no credentials, path, query or fragment, and never loopback (that is this
    /// phone, not a Host someone made a link for).
    static func origin(_ input: String) throws -> String {
        // Plain ASCII only, no whitespace/controls, and none of the characters that start credentials,
        // a query, a fragment or a path trick. This rejects before URLComponents' leniency can matter.
        guard input.utf8.allSatisfy({ $0 > 0x20 && $0 < 0x7F }) else { throw ParseError.badGatewayURL("not a plain address") }
        guard !input.contains("@") else { throw ParseError.badGatewayURL("credentials") }
        guard !input.contains("?"), !input.contains("#"), !input.contains("\\") else {
            throw ParseError.badGatewayURL("query or fragment")
        }
        guard let parts = URLComponents(string: input), let scheme = parts.scheme?.lowercased(),
              var host = parts.host?.lowercased(), !host.isEmpty
        else { throw ParseError.badGatewayURL("not a URL") }
        guard parts.user == nil, parts.password == nil else { throw ParseError.badGatewayURL("credentials") }
        guard parts.path.isEmpty || parts.path == "/" else { throw ParseError.badGatewayURL("path") }
        guard scheme == "https" else { throw ParseError.badGatewayURL("must be https") }
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))  // IPv6 literals may or may not carry brackets
        guard isPlainHost(host) else { throw ParseError.badGatewayURL("not a plain host name") }
        guard !isLoopback(host) else { throw ParseError.badGatewayURL("that is this phone") }
        if host.contains(":") { host = "[\(host)]" }
        var result = "https://\(host)"
        if let port = parts.port {
            guard (1...65535).contains(port) else { throw ParseError.badGatewayURL("port") }
            if port != 443 { result += ":\(port)" }
        }
        return result
    }

    /// A host name made of ASCII letters, digits, `.` and `-` (so also dotted IPv4), or an IPv6 literal (hex
    /// digits, `:` and, for a mapped IPv4, `.`). Anything else, a zone id (`%`) included, is refused.
    static func isPlainHost(_ host: String) -> Bool {
        guard !host.isEmpty else { return false }
        func hex(_ c: Character) -> Bool { c.isASCII && c.isHexDigit }
        if host.contains(":") { return host.allSatisfy { hex($0) || $0 == ":" || $0 == "." } }
        return host.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "." || $0 == "-" }
    }

    /// `localhost`, `::1` and the whole `127.` block (main refuses the first three names; a URL parser would
    /// also normalize `127.1` to `127.0.0.1`, which this phone does not, so the block is refused outright).
    static func isLoopback(_ host: String) -> Bool {
        host == "localhost" || host == "::1" || host == "0.0.0.0"
            || (host.hasPrefix("127.") && host.allSatisfy { $0.isNumber || $0 == "." })
    }

    // MARK: - What the confirm screen shows

    /// The host part, for "Connect to studio-mac (studio-mac.tail1234.ts.net)?".
    public var host: String {
        (URLComponents(string: gatewayURL)?.host ?? gatewayURL).trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    }

    /// "7F3A 91C2 E04B": the first six bytes of the fingerprint, as the Mac shows it next to a pairing request.
    public var fingerprint: String { Self.grouped(fingerprint: gatewayFingerprint) }

    public static func grouped(fingerprint: String) -> String {
        let hex = fingerprint.dropFirst("sha256:".count).prefix(12).uppercased()
        return stride(from: 0, to: hex.count, by: 4).map { i in
            let start = hex.index(hex.startIndex, offsetBy: i)
            return String(hex[start..<hex.index(start, offsetBy: min(4, hex.count - i))])
        }.joined(separator: " ")
    }

    public var transport: GatewayEndpoint.Transport { host.hasSuffix(".ts.net") ? .tailscale : .lan }

    /// The endpoint to pin. It holds the link's fingerprint until the first connect proves a key.
    public var endpoint: GatewayEndpoint {
        GatewayEndpoint(
            host: host, fingerprint: fingerprint, transport: transport,
            url: gatewayURL, identityKey: "", hostName: hostName, linkFingerprint: gatewayFingerprint)
    }
}
