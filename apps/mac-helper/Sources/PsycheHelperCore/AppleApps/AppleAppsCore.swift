import Foundation
import PsycheProtocol

// Apple app adapters (feature J6). Pure pieces: records (wire shapes from packages/protocol
// `schemas/apple-apps.ts`), granted Finder roots, script-output parsing and HTML escaping. App
// content is untrusted data; the live adapters live in PsycheHelperSystem.

public struct CalendarRecord: Codable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var source: String
    public var writable: Bool
    public var color: String?
    public init(id: String, title: String, source: String, writable: Bool, color: String? = nil) {
        self.id = id
        self.title = title
        self.source = source
        self.writable = writable
        self.color = color
    }
}

public struct CalendarEventRecord: Codable, Sendable, Equatable {
    public var id: String
    public var calendarId: String
    public var title: String
    public var start: String
    public var end: String
    public var allDay: Bool
    public var location: String?
    public var notes: String?
    public var url: String?
    public var recurring: Bool

    public init(id: String, calendarId: String, title: String, start: String, end: String, allDay: Bool = false,
                location: String? = nil, notes: String? = nil, url: String? = nil, recurring: Bool = false) {
        self.id = id
        self.calendarId = calendarId
        self.title = title
        self.start = start
        self.end = end
        self.allDay = allDay
        self.location = location
        self.notes = notes
        self.url = url
        self.recurring = recurring
    }

    /// Nil optionals encode as JSON null (the schema's `Nullable` fields are required keys).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(calendarId, forKey: .calendarId)
        try c.encode(title, forKey: .title)
        try c.encode(start, forKey: .start)
        try c.encode(end, forKey: .end)
        try c.encode(allDay, forKey: .allDay)
        try c.encode(location, forKey: .location)
        try c.encode(notes, forKey: .notes)
        try c.encode(url, forKey: .url)
        try c.encode(recurring, forKey: .recurring)
    }
}

public struct ReminderRecord: Codable, Sendable, Equatable {
    public var id: String
    public var listId: String
    public var title: String
    public var notes: String?
    public var due: String?
    public var completed: Bool
    public var priority: Int

    public init(id: String, listId: String, title: String, notes: String? = nil, due: String? = nil, completed: Bool = false, priority: Int = 0) {
        self.id = id
        self.listId = listId
        self.title = title
        self.notes = notes
        self.due = due
        self.completed = completed
        self.priority = priority
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(listId, forKey: .listId)
        try c.encode(title, forKey: .title)
        try c.encode(notes, forKey: .notes)
        try c.encode(due, forKey: .due)
        try c.encode(completed, forKey: .completed)
        try c.encode(priority, forKey: .priority)
    }
}

public struct MailSummaryRecord: Codable, Sendable, Equatable {
    public var id: String
    public var mailbox: String
    public var account: String
    public var subject: String
    public var from: String
    public var date: String
    public var read: Bool

    public init(id: String, mailbox: String, account: String, subject: String, from: String, date: String, read: Bool) {
        self.id = id
        self.mailbox = mailbox
        self.account = account
        self.subject = subject
        self.from = from
        self.date = date
        self.read = read
    }
}

public struct NoteSummaryRecord: Codable, Sendable, Equatable {
    public var id: String
    public var folder: String
    public var title: String
    public var modified: String

    public init(id: String, folder: String, title: String, modified: String) {
        self.id = id
        self.folder = folder
        self.title = title
        self.modified = modified
    }
}

public struct SafariTabRecord: Codable, Sendable, Equatable {
    public var window: Int
    public var index: Int
    public var title: String
    public var url: String
    public var current: Bool

    public init(window: Int, index: Int, title: String, url: String, current: Bool) {
        self.window = window
        self.index = index
        self.title = title
        self.url = url
        self.current = current
    }
}

// MARK: - Dates

public enum AppleDates {
    nonisolated(unsafe) static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    nonisolated(unsafe) static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    public static func string(_ d: Date) -> String { iso.string(from: d) }

    public static func parse(_ s: String) -> Date? { iso.date(from: s) ?? isoFractional.date(from: s) }

    /// Parses an IsoDateTime param or throws `invalid_params`.
    public static func param(_ s: String, field: String) throws -> Date {
        guard let d = parse(s) else { throw CapabilityError.invalidParams("\(field) must be an ISO 8601 date-time", field: field) }
        return d
    }

    /// AppleScript `«class isot»` text (`2026-10-19T09:30:00`, local time, no zone) → ISO 8601.
    public static func fromAppleScript(_ s: String, timeZone: TimeZone = .current) -> String? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f.date(from: s).map(string)
    }
}

// MARK: - Script output

/// Scripts return records as text: fields joined by U+001F, records by U+001E, so no field
/// content can be mistaken for structure (both are stripped from field values in the scripts).
public enum ScriptRecords {
    public static let fieldSeparator = "\u{1F}"
    public static let recordSeparator = "\u{1E}"

    public static func parse(_ text: String?, fields: Int) -> [[String]] {
        guard let text, !text.isEmpty else { return [] }
        return text.components(separatedBy: recordSeparator).compactMap { rec in
            let f = rec.components(separatedBy: fieldSeparator)
            return f.count == fields ? f : nil
        }
    }
}

// MARK: - Notes HTML

public enum NotesHTML {
    /// Plain text → Notes body HTML: the title as the first line, text escaped, line breaks kept.
    public static func body(title: String, text: String) -> String {
        let lines = text.components(separatedBy: .newlines).map { "<div>\(escape($0).isEmpty ? "<br>" : escape($0))</div>" }
        return "<div><h1>\(escape(title))</h1></div>" + lines.joined()
    }

    public static func escape(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }
}

// MARK: - Finder roots

/// Folders the owner granted (`permissions.folders` in `$PSYCHE_HOME/config.json`). Finder
/// adapters list and reveal only inside them; nothing is granted by default.
public struct FinderRoots: Sendable, Equatable {
    public var roots: [String]

    public init(roots: [String]) {
        self.roots = roots.map { Self.canonical($0) }
    }

    static func canonical(_ path: String) -> String {
        URL(fileURLWithPath: (path as NSString).expandingTildeInPath).resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// Reads `permissions.folders[].path` from the Gateway's config (read-only for the helper).
    public static func load(environment: [String: String] = ProcessInfo.processInfo.environment) -> FinderRoots {
        let path = (HelperPaths.psycheHome(environment: environment) as NSString).appendingPathComponent("config.json")
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let perms = json["permissions"] as? [String: Any],
              let folders = perms["folders"] as? [[String: Any]]
        else { return FinderRoots(roots: []) }
        return FinderRoots(roots: folders.compactMap { $0["path"] as? String })
    }

    /// The canonical path if it lies inside a granted root, else `policy_denied`.
    public func resolve(_ path: String) throws -> String {
        guard path.hasPrefix("/") || path.hasPrefix("~") else { throw CapabilityError.invalidParams("path must be absolute", field: "path") }
        guard !roots.isEmpty else {
            throw CapabilityError(.policyDenied, reason: "no_granted_folders", "No folders are granted. Add one in Settings → Permissions → Folders.")
        }
        let p = Self.canonical(path)
        guard roots.contains(where: { p == $0 || p.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") }) else {
            throw CapabilityError(.policyDenied, reason: "outside_granted_folders", "\(path) is outside the granted folders", details: ["path": .string(path)])
        }
        return p
    }
}
