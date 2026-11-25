import Foundation

/// Which hosts count as "this local network": the Swift twin of `lanHostKind` in
/// `packages/protocol/src/lan-address.ts`, which the Gateway (what it listens on), the desktop (what it may pin a
/// self-signed certificate for) and the pairing-link parser all share. Allowed: a `.local` multicast-DNS name, an
/// RFC 1918 IPv4 address and an IPv6 unique-local address (`fc00::/7`). Refused on purpose: global and link-local
/// IPv6, every public, link-local, loopback, carrier-grade-NAT and unspecified IPv4 address, IPv4-mapped IPv6, and
/// anything with a zone id (`%`).
public enum LanHost {
    public enum Kind: Equatable, Sendable { case mdns, ipv4Private, ipv6UniqueLocal }

    /// The kind of local-network host `host` is (an IPv6 literal may carry brackets), or nil.
    public static func kind(of host: String) -> Kind? {
        var h = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if h.hasSuffix(".") { h.removeLast() }  // one trailing dot is the same name
        guard !h.isEmpty, h.utf8.count <= 253, !h.contains("%") else { return nil }
        let bracketed = h.hasPrefix("[") && h.hasSuffix("]")
        let bare = bracketed ? String(h.dropFirst().dropLast()) : h
        if bracketed || bare.contains(":") {
            guard let groups = parseIPv6(bare), isUniqueLocal(groups) else { return nil }
            return .ipv6UniqueLocal
        }
        if !bare.isEmpty, bare.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2E }) {
            guard let v4 = parseIPv4(bare), isPrivate(v4) else { return nil }
            return .ipv4Private
        }
        return isMDNSName(bare) ? .mdns : nil
    }

    /// `a.b.c.d` with plain decimal octets (no leading zeros, no short forms).
    static func parseIPv4(_ text: String) -> [Int]? {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var out: [Int] = []
        for part in parts {
            guard (1...3).contains(part.utf8.count), part.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }),
                  part == "0" || !part.hasPrefix("0"), let n = Int(part), n <= 255
            else { return nil }
            out.append(n)
        }
        return out
    }

    static func isPrivate(_ a: [Int]) -> Bool {
        a[0] == 10 || (a[0] == 172 && (16...31).contains(a[1])) || (a[0] == 192 && a[1] == 168)
    }

    /// Eight 16-bit groups of an IPv6 literal without brackets or a zone id, or nil.
    static func parseIPv6(_ text: String) -> [UInt16]? {
        guard !text.isEmpty, text.utf8.allSatisfy({ isHex($0) || $0 == 0x3A || $0 == 0x2E }) else { return nil }
        let halves = text.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        func groups(_ side: String) -> [UInt16]? {
            if side.isEmpty { return [] }
            var out: [UInt16] = []
            let parts = side.split(separator: ":", omittingEmptySubsequences: false)
            for (i, part) in parts.enumerated() {
                if part.contains(".") {
                    guard i == parts.count - 1, let v4 = parseIPv4(String(part)) else { return nil }
                    out.append(UInt16(v4[0] * 256 + v4[1]))
                    out.append(UInt16(v4[2] * 256 + v4[3]))
                } else {
                    guard (1...4).contains(part.utf8.count), part.utf8.allSatisfy(isHex), let n = UInt16(part, radix: 16)
                    else { return nil }
                    out.append(n)
                }
            }
            return out
        }
        guard let head = groups(halves[0]) else { return nil }
        if halves.count == 1 { return head.count == 8 ? head : nil }
        guard let tail = groups(halves[1]) else { return nil }
        let missing = 8 - head.count - tail.count
        guard missing >= 1 else { return nil }  // `::` stands for at least one group
        return head + Array(repeating: 0, count: missing) + tail
    }

    /// `fc00::/7`.
    static func isUniqueLocal(_ g: [UInt16]) -> Bool { (g[0] & 0xFE00) == 0xFC00 }

    /// The text form a URL parser writes (lower case, no leading zeros, the longest run of two or more zero groups,
    /// the first on a tie, written `::`). A link must spell the address this way.
    static func canonicalIPv6(_ g: [UInt16]) -> String {
        var bestStart = -1, bestLen = 0, i = 0
        while i < 8 {
            if g[i] == 0 {
                var j = i
                while j < 8, g[j] == 0 { j += 1 }
                if j - i > bestLen { bestStart = i; bestLen = j - i }
                i = j
            } else { i += 1 }
        }
        if bestLen < 2 { bestStart = -1 }
        var out = "", k = 0
        while k < 8 {
            if k == bestStart {
                out += k == 0 ? "::" : ":"
                k += bestLen
                continue
            }
            out += String(g[k], radix: 16)
            if k < 7 { out += ":" }
            k += 1
        }
        return out
    }

    private static func isHex(_ b: UInt8) -> Bool { (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66) || (b >= 0x41 && b <= 0x46) }

    private static func isMDNSName(_ name: String) -> Bool {
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, labels.last == "local" else { return false }
        return labels.allSatisfy { label in
            let u = Array(label.utf8)
            func alnum(_ b: UInt8) -> Bool { (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39) }
            guard (1...63).contains(u.count), alnum(u[0]), alnum(u[u.count - 1]) else { return false }
            return u.allSatisfy { alnum($0) || $0 == 0x2D }
        }
    }

    /// A LAN origin written exactly as `URL.origin` writes it (`isLanLinkOrigin` in `pairing-link.ts`, an optional
    /// final `/` allowed): `https://host` or `https://host:port`, a lower-case host that `kind(of:)` accepts, no
    /// credentials, path, query, fragment, zone id or default port, a canonically spelled IPv6 literal. Returns the
    /// normalized origin (no final `/`), or nil.
    public static func lanOrigin(_ text: String) -> String? {
        // Printable ASCII only; no `%` (zone ids), `?`, `#`, `\`, `@` (credentials).
        guard !text.isEmpty, text.utf8.count <= 300,
              text.utf8.allSatisfy({ $0 > 0x20 && $0 < 0x7F && $0 != 0x25 && $0 != 0x3F && $0 != 0x23 && $0 != 0x5C && $0 != 0x40 })
        else { return nil }
        guard text.hasPrefix("https://") else { return nil }
        var rest = String(text.dropFirst("https://".count))
        if rest.hasSuffix("/") { rest.removeLast() }
        guard !rest.isEmpty, !rest.contains("/") else { return nil }
        var host: String
        var portText: String?
        if rest.hasPrefix("[") {
            guard let close = rest.firstIndex(of: "]") else { return nil }
            let inner = String(rest[rest.index(after: rest.startIndex)..<close])
            let after = rest[rest.index(after: close)...]
            if !after.isEmpty {
                guard after.hasPrefix(":") else { return nil }
                portText = String(after.dropFirst())
            }
            guard let groups = parseIPv6(inner), canonicalIPv6(groups) == inner, isUniqueLocal(groups) else { return nil }
            host = "[\(inner)]"
        } else {
            let parts = rest.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count <= 2 else { return nil }
            host = String(parts[0])
            if parts.count == 2 { portText = String(parts[1]) }
            guard host == host.lowercased(), let k = kind(of: host), k != .ipv6UniqueLocal else { return nil }
            // `10.0.0.5.` is a DNS name to the system resolver, not a literal, and `URL.origin` writes it without the
            // dot: only a `.local` name may end in one.
            if k == .ipv4Private, host.hasSuffix(".") { return nil }
        }
        var result = "https://\(host)"
        if let portText {
            guard (1...5).contains(portText.utf8.count), portText.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }),
                  !portText.hasPrefix("0"), let port = Int(portText), (1...65535).contains(port), port != 443
            else { return nil }
            result += ":\(port)"
        }
        return result
    }
}
