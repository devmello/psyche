import Foundation
import PsycheProtocol

// Reminders and Calendar wave 1 (docs/connectors/apple-apps-2026.md §4.2–4.3, R1–R5, C1–C4):
// pure pieces. EventKit mapping lives in PsycheHelperSystem.

/// `AppleAlarm`: minutes before the start / due time, or an absolute time.
public enum AlarmSpec: Codable, Sendable, Equatable {
    case relative(minutes: Int)
    case absolute(String)

    enum Keys: String, CodingKey { case relativeMinutes, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let m = try c.decodeIfPresent(Int.self, forKey: .relativeMinutes) {
            guard (-40_320...0).contains(m) else {
                throw CapabilityError.invalidParams("relativeMinutes is -40320…0 (minutes before)", field: "alarm")
            }
            self = .relative(minutes: m)
        } else if let at = try c.decodeIfPresent(String.self, forKey: .at) {
            _ = try AppleDates.param(at, field: "alarm.at")
            self = .absolute(at)
        } else {
            throw CapabilityError.invalidParams("an alarm is {relativeMinutes} or {at}", field: "alarm")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .relative(let m): try c.encode(m, forKey: .relativeMinutes)
        case .absolute(let at): try c.encode(at, forKey: .at)
        }
    }
}

/// `AppleRecurrence`: the RRULE subset EventKit supports.
public struct RecurrenceSpec: Codable, Sendable, Equatable {
    public var frequency: String
    public var interval: Int?
    public var daysOfWeek: [String]?
    public var until: String?
    public var count: Int?

    public static let frequencies = ["daily", "weekly", "monthly", "yearly"]
    public static let days = ["su", "mo", "tu", "we", "th", "fr", "sa"]  // EKWeekday order (Sunday = 1)

    public init(frequency: String, interval: Int? = nil, daysOfWeek: [String]? = nil, until: String? = nil, count: Int? = nil) {
        self.frequency = frequency
        self.interval = interval
        self.daysOfWeek = daysOfWeek
        self.until = until
        self.count = count
    }

    public func validate() throws {
        guard Self.frequencies.contains(frequency) else { throw CapabilityError.invalidParams("frequency is daily, weekly, monthly or yearly", field: "recurrence") }
        if let i = interval, !(1...999).contains(i) { throw CapabilityError.invalidParams("interval is 1–999", field: "recurrence") }
        if let c = count, !(1...999).contains(c) { throw CapabilityError.invalidParams("count is 1–999", field: "recurrence") }
        if until != nil, count != nil { throw CapabilityError.invalidParams("give until or count, not both", field: "recurrence") }
        if let u = until { _ = try AppleDates.param(u, field: "recurrence.until") }
        if let d = daysOfWeek {
            guard frequency == "weekly" else { throw CapabilityError.invalidParams("daysOfWeek is for weekly rules", field: "recurrence") }
            guard d.count <= 7, d.allSatisfy(Self.days.contains), Set(d).count == d.count else {
                throw CapabilityError.invalidParams("daysOfWeek takes mo, tu, we, th, fr, sa, su once each", field: "recurrence")
            }
        }
    }
}

/// An attendee as EventKit reports it (read-only).
public struct AttendeeRecord: Codable, Sendable, Equatable {
    public var name: String
    public var email: String?
    public var status: String
    public var organizer: Bool

    public init(name: String, email: String?, status: String, organizer: Bool) {
        self.name = name
        self.email = email
        self.status = status
        self.organizer = organizer
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(email, forKey: .email)
        try c.encode(status, forKey: .status)
        try c.encode(organizer, forKey: .organizer)
    }
}

/// `AppleBusyBlock`.
public struct BusyBlockRecord: Codable, Sendable, Equatable {
    public var start: String
    public var end: String
    public var calendarId: String
    public var availability: String

    public init(start: String, end: String, calendarId: String, availability: String) {
        self.start = start
        self.end = end
        self.calendarId = calendarId
        self.availability = availability
    }

    /// Free events are left out; blocks come in start order.
    public static func blocks(_ xs: [BusyBlockRecord]) -> [BusyBlockRecord] {
        xs.filter { $0.availability != "free" }.sorted { ($0.start, $0.end) < ($1.start, $1.end) }
    }
}

public enum ConferenceLinks {
    static let hosts = ["zoom.us", "zoomgov.com", "meet.google.com", "teams.microsoft.com", "teams.live.com", "webex.com"]

    /// The first meeting link in the event's URL, location or notes (Zoom, Meet, Teams, Webex).
    public static func find(_ texts: [String?]) -> String? {
        guard let re = try? NSRegularExpression(pattern: #"https://[^\s<>"')\]]+"#, options: [.caseInsensitive]) else { return nil }
        for t in texts.compactMap({ $0 }) {
            let ns = t as NSString
            for m in re.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
                let s = ns.substring(with: m.range).trimmingCharacters(in: CharacterSet(charactersIn: ".,;"))
                guard let host = URL(string: s)?.host?.lowercased() else { continue }
                if hosts.contains(where: { host == $0 || host.hasSuffix("." + $0) }) { return s }
            }
        }
        return nil
    }
}

/// `reminders.list` filters (R1) applied to EventKit's results, soonest due first.
public struct ReminderQuery: Sendable, Equatable {
    public var overdue: Bool
    public var dueToday: Bool
    public var query: String
    /// Ids of flagged reminders (from Reminders scripting) when `flagged` was asked for.
    public var flaggedIds: Set<String>?

    public init(overdue: Bool = false, dueToday: Bool = false, query: String = "", flaggedIds: Set<String>? = nil) {
        self.overdue = overdue
        self.dueToday = dueToday
        self.query = query
        self.flaggedIds = flaggedIds
    }

    public func apply(_ rs: [ReminderRecord], now: Date, calendar: Calendar = .current, limit: Int) -> [ReminderRecord] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let out = rs.filter { r in
            let due = r.due.flatMap(AppleDates.parse)
            if overdue, r.completed || !(due.map { $0 < now } ?? false) { return false }
            if dueToday, !(due.map { calendar.isDate($0, inSameDayAs: now) } ?? false) { return false }
            if let f = flaggedIds, !f.contains(r.id) { return false }
            if !q.isEmpty, !(r.title.lowercased().contains(q) || (r.notes ?? "").lowercased().contains(q)) { return false }
            return true
        }.map { r -> ReminderRecord in
            var r = r
            if let f = flaggedIds { r.flagged = f.contains(r.id) }
            return r
        }
        // Soonest due first; undated last, then by title.
        return out.sorted { a, b in
            switch (a.due, b.due) {
            case let (x?, y?): return x == y ? a.title < b.title : x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.title < b.title
            }
        }.prefix(max(0, limit)).map { $0 }
    }

    /// Reminders scripting ids look like `x-apple-reminder://<UUID>`; EventKit uses the UUID.
    public static func eventKitId(fromScripting id: String) -> String {
        id.hasPrefix("x-apple-reminder://") ? String(id.dropFirst("x-apple-reminder://".count)) : id
    }
}
