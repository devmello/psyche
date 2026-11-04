import CryptoKit
import Foundation
import PsycheShared
import PsycheWire

/// A parsed `psyche-pair:v1:<base64url JSON>` link. The rules mirror `packages/protocol/src/pairing-link.ts`:
/// the link is read only by the in-app scanner or the paste field and is never a URL handler
/// (CVE-2026-25253), so the Gateway address always comes from a person pointing the camera at a code.
public struct PairingLink: Equatable, Sendable {
    public static let prefix = "psyche-pair:v1:"

    /// `https://host[:port]`, or `http://` to loopback only. No path, query or credentials.
    public let gatewayURL: String
    /// The Gateway identity public key, base64url raw Ed25519 (43 characters). This becomes the pin.
    public let gatewayIdentityKey: String
    /// Single use, ten minutes. Sent once, in `connect.verify`, after the Gateway's key was checked.
    public let setupToken: String
    public let hostName: String

    public enum ParseError: Error, Equatable, LocalizedError {
        case notAPairingLink
        case tooLong
        case damaged
        case missingField(String)
        case badKey
        case badToken
        case badHostName
        case badGatewayURL(String)

        public var errorDescription: String? {
            switch self {
            case .notAPairingLink: "That isn't a Psyche pairing code. Open Settings → Devices → Add phone on your Mac."
            case .tooLong, .damaged, .missingField: "That pairing code is damaged. Make a new one on your Mac."
            case .badKey, .badToken, .badHostName: "That pairing code isn't valid. Make a new one on your Mac."
            case .badGatewayURL(let why): "That pairing code points somewhere Psyche won't connect (\(why))."
            }
        }
    }

    private static let maxLinkChars = 2048
    private static let maxHostName = 128

    public static func parse(_ text: String) throws -> PairingLink {
        let link = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard link.utf16.count <= maxLinkChars else { throw ParseError.tooLong }
        guard link.hasPrefix(prefix) else { throw ParseError.notAPairingLink }
        let body = String(link.dropFirst(prefix.count))
        guard isBase64URL(body), body.count % 4 != 1, let data = Base64URL.decode(body),
              let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any],
              String(data: data, encoding: .utf8) != nil
        else { throw ParseError.damaged }
        func field(_ key: String) throws -> String {
            guard let value = object[key] as? String else { throw ParseError.missingField(key) }
            return value
        }
        let url = try field("gatewayUrl"), key = try field("gatewayIdentityKey")
        let token = try field("setupToken"), host = try field("hostName")
        guard isKey(key) else { throw ParseError.badKey }
        guard isKey(token) else { throw ParseError.badToken }
        guard validHostName(host) else { throw ParseError.badHostName }
        return PairingLink(
            gatewayURL: try origin(url), gatewayIdentityKey: key, setupToken: token, hostName: host)
    }

    /// 43 base64url characters: 32 bytes with no padding.
    static func isKey(_ text: String) -> Bool {
        text.utf8.count == 43 && isBase64URL(text) && Base64URL.decode(text)?.count == 32
    }

    private static func isBase64URL(_ text: String) -> Bool {
        text.utf8.allSatisfy {
            ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D || $0 == 0x5F
        }
    }

    /// Control, format (bidi marks and overrides, zero-width joiners, tag characters), line and paragraph
    /// separators, and the Hangul fillers that render as nothing. A host name is shown in
    /// "Connect to studio-mac?", so one that could reshape or hide part of the sentence is refused.
    static func validHostName(_ name: String) -> Bool {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.utf16.count <= maxHostName else { return false }
        for scalar in name.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator: return false
            default: break
            }
            if scalar.value == 0x115F || scalar.value == 0x3164 { return false }
        }
        return true
    }

    /// Validates a Gateway origin like a typed address and returns it normalized (lowercase host, default port dropped).
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
        // Exactly these three names: `x.localhost` is not guaranteed to reach loopback on every resolver.
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))  // IPv6 literals may or may not carry brackets
        let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
        guard scheme == "https" || (scheme == "http" && loopback) else { throw ParseError.badGatewayURL("must be https") }
        if host.contains(":") { host = "[\(host)]" }
        var result = "\(scheme)://\(host)"
        if let port = parts.port {
            guard (1...65535).contains(port) else { throw ParseError.badGatewayURL("port") }
            let isDefault = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
            if !isDefault { result += ":\(port)" }
        }
        return result
    }

    // MARK: - What the confirm screen shows

    /// The host part, for "Connect to studio-mac (studio-mac.tail1234.ts.net)?".
    public var host: String {
        (URLComponents(string: gatewayURL)?.host ?? gatewayURL).trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    }

    /// "7F3A 91C2 E04B": the first six bytes of SHA-256 of the raw key, as the Mac shows it next to a pairing request.
    public var fingerprint: String { Self.fingerprint(ofKey: gatewayIdentityKey) }

    public static func fingerprint(ofKey key: String) -> String {
        guard let raw = Base64URL.decode(key) else { return "" }
        let hex = SHA256.hash(data: raw).prefix(6).map { String(format: "%02X", $0) }.joined()
        return stride(from: 0, to: hex.count, by: 4).map { i in
            let start = hex.index(hex.startIndex, offsetBy: i)
            return String(hex[start..<hex.index(start, offsetBy: 4)])
        }.joined(separator: " ")
    }

    public var transport: GatewayEndpoint.Transport { host.hasSuffix(".ts.net") ? .tailscale : .lan }

    public var endpoint: GatewayEndpoint {
        GatewayEndpoint(
            host: host, fingerprint: fingerprint, transport: transport,
            url: gatewayURL, identityKey: gatewayIdentityKey, hostName: hostName)
    }
}
