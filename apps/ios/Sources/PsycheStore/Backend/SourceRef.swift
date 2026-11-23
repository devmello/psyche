import Foundation

// The sources a widget or a document was built from (wire `AnswerSource`, packages/protocol/src/schemas/sources.ts).
// The Gateway attaches only sources it recorded itself and keeps only in-app routes. The phone checks the route
// again (`SourceRoute`), and shows titles and passages as plain text: they are model or web text.

/// One source behind a widget or a document. Decoded tolerantly: a source with no id is dropped, anything else
/// that is malformed reads as empty.
public struct SourceRef: Sendable, Equatable, Identifiable, Codable {
    /// The schema caps a list at 20 sources.
    public static let maxCount = 20

    public var id: String
    public var title: String
    /// The kind of thing it came from ("mail", "messages", "library"), as the Gateway writes it.
    public var source: String
    /// An in-app path such as `/library/<id>` or `/chat/<id>`, or nil when there is nowhere to open.
    public var route: String?
    /// The cited passage. Plain text only.
    public var span: String
    public var date: String
    /// Written by someone else (mail, a web page): drawn with the untrusted border.
    public var isUntrusted: Bool

    public init(
        id: String, title: String, source: String = "", route: String? = nil, span: String = "", date: String = "",
        isUntrusted: Bool = false
    ) {
        self.id = id
        self.title = title
        self.source = source
        self.route = route
        self.span = span
        self.date = date
        self.isUntrusted = isUntrusted
    }

    /// One wire source; nil when it has no id.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, !id.isEmpty else { return nil }
        self.init(
            id: id,
            title: json["title"]?.stringValue ?? "",
            source: json["source"]?.stringValue ?? "",
            route: json["route"]?.stringValue,
            span: json["span"]?.stringValue ?? "",
            date: json["date"]?.stringValue ?? "",
            isUntrusted: json["provenance"]?.stringValue == "untrusted")
    }

    /// A wire list of sources, the readable ones, at most `maxCount`. Nil or a non-list reads as none.
    public static func list(_ json: JSONValue?) -> [SourceRef] {
        Array((json?.arrayValue ?? []).compactMap(SourceRef.init(json:)).prefix(maxCount))
    }

    /// Whether its route is a plain in-app path (see `SourceRoute`).
    public var canOpen: Bool { SourceRoute.isSafe(route) }
}

/// Which routes a source may open: an in-app path, optionally with a query string the Gateway writes
/// (`/chat/<id>?message=…`, `/library/all?item=mail:m1`). Routes that are safe but unknown to the app are the
/// host's to refuse.
///
/// Path (before the `?`): exactly one leading `/`. After percent-decoding there is no `//`, no `\`, no
/// whitespace, no `:`, and no control, format or private-use character. A malformed `%` escape refuses.
/// Query (after one optional `?`): `key=value` pairs joined by `&`. Keys are `[A-Za-z0-9_-]+`. Values are
/// unreserved characters, `:` and valid `%XX` escapes only. Anywhere: no `#`, no whitespace, no control
/// characters, at most `maxLength` bytes.
public enum SourceRoute {
    /// The longest route the phone will open.
    public static let maxLength = 512

    public static func isSafe(_ route: String?) -> Bool {
        guard let route, !route.isEmpty, route.utf8.count <= maxLength else { return false }
        for scalar in route.unicodeScalars {
            if scalar == "#" || scalar.properties.isWhitespace || isControlish(scalar) { return false }
        }
        let halves = route.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        guard let path = halves.first, isSafePath(String(path)) else { return false }
        if halves.count == 2 { return isSafeQuery(String(halves[1])) }
        return true
    }

    private static func isSafePath(_ path: String) -> Bool {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let decoded = path.removingPercentEncoding else { return false }
        guard !decoded.hasPrefix("//") else { return false }
        for scalar in decoded.unicodeScalars {
            if scalar == "\\" || scalar == ":" || scalar.properties.isWhitespace || isControlish(scalar) { return false }
        }
        return true
    }

    private static func isSafeQuery(_ query: String) -> Bool {
        guard !query.isEmpty else { return false }
        for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2, isKey(parts[0]), isValue(parts[1]) else { return false }
        }
        return true
    }

    private static func isKey(_ key: Substring) -> Bool {
        !key.isEmpty && key.unicodeScalars.allSatisfy { scalar in
            ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
                || scalar == "_" || scalar == "-"
        }
    }

    /// Unreserved characters, `:` and `%XX`. A value of at least one character, whose decoded form has no
    /// whitespace or control character, no backslash, no `//` and no `..` segment.
    private static func isValue(_ value: Substring) -> Bool {
        guard !value.isEmpty else { return false }
        let scalars = Array(value.unicodeScalars)
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if scalar == "%" {
                guard index + 2 < scalars.count, isHex(scalars[index + 1]), isHex(scalars[index + 2]) else { return false }
                index += 3
                continue
            }
            let allowed = ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
                || "-._~:".unicodeScalars.contains(scalar)
            guard allowed else { return false }
            index += 1
        }
        guard let decoded = String(value).removingPercentEncoding else { return false }
        // A decoded value is a path or an id the phone may open: no backslash, no `//`, no `..` segment.
        if decoded.unicodeScalars.contains("\\") || decoded.contains("//") { return false }
        if decoded.split(separator: "/", omittingEmptySubsequences: false).contains("..") { return false }
        return !decoded.unicodeScalars.contains { $0.properties.isWhitespace || isControlish($0) }
    }

    private static func isHex(_ scalar: Unicode.Scalar) -> Bool {
        ("0"..."9").contains(scalar) || ("A"..."F").contains(scalar) || ("a"..."f").contains(scalar)
    }

    private static func isControlish(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .control, .format, .lineSeparator, .paragraphSeparator, .unassigned, .privateUse, .surrogate:
            return true
        default:
            return false
        }
    }
}
