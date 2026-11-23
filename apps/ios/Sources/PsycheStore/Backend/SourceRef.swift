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

/// Which routes a source may open. Only a plain in-app path: one leading `/`, then ordinary path characters.
/// A `//` (protocol-relative), a backslash, whitespace, a control or format character, a query or a fragment,
/// and anything with a scheme is refused. Routes that are safe but unknown to the app are the host's to refuse.
public enum SourceRoute {
    /// The longest route the phone will open.
    public static let maxLength = 512

    public static func isSafe(_ route: String?) -> Bool {
        guard let route, !route.isEmpty, route.utf8.count <= maxLength else { return false }
        guard route.hasPrefix("/"), !route.hasPrefix("//") else { return false }
        for scalar in route.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .control, .format, .spaceSeparator, .lineSeparator, .paragraphSeparator, .unassigned,
                .privateUse, .surrogate:
                return false
            default: break
            }
            if scalar == "\\" || scalar == "?" || scalar == "#" || scalar == ":" { return false }
        }
        return true
    }
}
