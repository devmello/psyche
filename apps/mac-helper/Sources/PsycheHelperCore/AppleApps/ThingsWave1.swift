import Foundation
import PsycheProtocol

// Things 3 wave 1 (docs/connectors/apple-apps-2026.md §5, §8 item 9): AppleScript reads, URL-scheme
// writes. The auth token for `update` comes from the Gateway (a vault item) with each call and is
// never stored by the helper.

/// `ThingsTodo`.
public struct ThingsTodoRecord: Codable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var notes: String
    public var status: String
    public var when: String?
    public var deadline: String?
    public var project: String?
    public var area: String?
    public var tags: [String]
    public var modified: String?

    public init(id: String, title: String, notes: String, status: String, when: String?, deadline: String?, project: String?, area: String?,
                tags: [String], modified: String?) {
        self.id = id
        self.title = title
        self.notes = notes
        self.status = status
        self.when = when
        self.deadline = deadline
        self.project = project
        self.area = area
        self.tags = tags
        self.modified = modified
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(notes, forKey: .notes)
        try c.encode(status, forKey: .status)
        try c.encode(when, forKey: .when)
        try c.encode(deadline, forKey: .deadline)
        try c.encode(project, forKey: .project)
        try c.encode(area, forKey: .area)
        try c.encode(tags, forKey: .tags)
        try c.encode(modified, forKey: .modified)
    }
}

public enum ThingsWave1 {
    public static let lists = ["inbox", "today", "upcoming", "anytime", "someday", "logbook", "project", "area", "tag"]
    /// Things' built-in list names (AppleScript `list "…"`).
    public static let builtIn = ["inbox": "Inbox", "today": "Today", "upcoming": "Upcoming", "anytime": "Anytime", "someday": "Someday", "logbook": "Logbook"]

    public static func checkWhen(_ s: String) throws {
        let ok = ["today", "tomorrow", "evening", "anytime", "someday"].contains(s) || isDate(s)
        guard ok else { throw CapabilityError.invalidParams("when is today, tomorrow, evening, anytime, someday or YYYY-MM-DD", field: "when") }
    }

    public static func isDate(_ s: String) -> Bool {
        let p = s.split(separator: "-")
        guard s.count == 10, p.count == 3, p[0].count == 4, let m = Int(p[1]), let d = Int(p[2]), Int(p[0]) != nil else { return false }
        return (1...12).contains(m) && (1...31).contains(d)
    }

    public static func checkTags(_ xs: [String], field: String) throws {
        guard xs.count <= 20, xs.allSatisfy({ !$0.isEmpty && $0.count <= 100 && !$0.contains(",") && !$0.contains(where: \.isNewline) }) else {
            throw CapabilityError.invalidParams("up to 20 tags, without commas or line breaks", field: field)
        }
    }

    /// Things ids are alphanumeric (22 characters today).
    public static func checkId(_ id: String) throws {
        guard (8...64).contains(id.count), id.allSatisfy({ $0.isLetter || $0.isNumber }), id.unicodeScalars.allSatisfy(\.isASCII) else {
            throw CapabilityError.invalidParams("id is a Things to-do id", field: "id")
        }
    }

    static var valueAllowed: CharacterSet {
        var s = CharacterSet.alphanumerics
        s.insert(charactersIn: "-._~")
        return s
    }

    static func url(_ command: String, _ items: [(String, String?)]) -> URL? {
        let q = items.compactMap { k, v -> String? in
            guard let v else { return nil }
            return "\(k)=\(v.addingPercentEncoding(withAllowedCharacters: valueAllowed) ?? "")"
        }.joined(separator: "&")
        return URL(string: "things:///\(command)?\(q)")
    }

    /// `things:///add?…`: no auth token needed.
    public static func addURL(title: String, notes: String?, when: String?, deadline: String?, tags: [String]?, list: String?, checklist: [String]?) -> URL? {
        url("add", [("title", title), ("notes", notes), ("when", when), ("deadline", deadline), ("tags", tags.map { $0.joined(separator: ",") }),
                    ("list", list), ("checklist-items", checklist.map { $0.joined(separator: "\n") })])
    }

    /// `things:///update?…`: needs the owner's auth token. `deadline: .some(nil)` clears it.
    public static func updateURL(id: String, authToken: String, title: String?, appendNotes: String?, when: String?, deadline: String??,
                                 addTags: [String]?, completed: Bool? = nil, canceled: Bool? = nil) -> URL? {
        var items: [(String, String?)] = [("id", id), ("auth-token", authToken), ("title", title), ("append-notes", appendNotes), ("when", when)]
        if case .some(let d) = deadline { items.append(("deadline", d ?? "")) }
        items += [("add-tags", addTags.map { $0.joined(separator: ",") }), ("completed", completed.map { $0 ? "true" : "false" }),
                  ("canceled", canceled.map { $0 ? "true" : "false" })]
        return url("update", items)
    }
}
