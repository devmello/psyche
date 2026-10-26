import AppKit
import EventKit
import Foundation
import OSAKit
import PsycheHelperCore
import PsycheProtocol

// Live backends for the Apple app adapters (J6) behind protocols, so capabilities are tested with
// fakes and no TCC prompt runs in CI.

public protocol CalendarBackend: Sendable {
    func calendars() async throws -> [CalendarRecord]
    /// Start order; `query` matches the title, location or notes (C1).
    func events(from: Date, to: Date, calendarIds: [String]?, query: String?, limit: Int) async throws -> [CalendarEventRecord]
    func create(_ input: CalendarEventInput) async throws -> CalendarEventRecord
    func update(_ update: CalendarEventPatch) async throws -> CalendarEventRecord
    // Wave 1 (C2, C4).
    func freeBusy(from: Date, to: Date, calendarIds: [String]?) async throws -> [BusyBlockRecord]
    func deleteEvent(id: String, span: String?) async throws
}

public protocol RemindersBackend: Sendable {
    func lists() async throws -> [CalendarRecord]
    /// Soonest due first, after `filter` (R1).
    func reminders(listIds: [String]?, completed: Bool?, dueBefore: Date?, filter: ReminderQuery, limit: Int) async throws -> [ReminderRecord]
    func create(_ input: ReminderInput) async throws -> ReminderRecord
    func update(_ patch: ReminderPatch) async throws -> ReminderRecord
    // Wave 1 (R3–R5).
    /// By id, or the one open reminder with exactly `title` (in `listId` when given).
    func complete(id: String?, title: String?, listId: String?, completed: Bool) async throws -> ReminderRecord
    func delete(id: String) async throws
    /// EventKit has no flag: Reminders scripting.
    func setFlagged(id: String, flagged: Bool) async throws
    /// EventKit ids of flagged reminders (Reminders scripting).
    func flaggedIds() async throws -> Set<String>
}

public protocol MailBackend: Sendable {
    /// Newest first (#626).
    func search(_ filter: MailSearchFilter, mailbox: String?, account: String?, limit: Int) async throws -> [MailSummaryRecord]
    func read(id: String, mailbox: String?, account: String?, maxLength: Int) async throws -> (MailSummaryRecord, to: [String], cc: [String], body: String)
    /// Saves a draft, or sends when `send` (only ever called with an approval). A saved draft
    /// stays open in Mail (hidden) and is returned, so `sendDraft` can send it.
    @discardableResult
    func compose(_ draft: MailDraft, send: Bool) async throws -> MailDraftRecord?
    // Wave 1 (docs/connectors/apple-apps-2026.md §4.1).
    /// Every mailbox of `account` (all accounts when nil) with its unread count, plus the unified inbox.
    func mailboxes(account: String?) async throws -> [MailboxRecord]
    /// The messages selected in Mail's front viewer, newest first; empty when Mail is not running.
    func selected(limit: Int) async throws -> [MailSummaryRecord]
    /// `reply` / `forward` in Mail, `body` put above the quoted message, saved as a draft.
    func replyDraft(id: String, mailbox: String?, account: String?, body: String, replyAll: Bool, cc: [String]) async throws -> MailDraftRecord
    func forwardDraft(id: String, mailbox: String?, account: String?, to: [String], cc: [String], body: String) async throws -> MailDraftRecord
    /// The open draft as it is now (nil when it is no longer open in Mail).
    func draft(id: String) async throws -> MailDraftRecord?
    func sendDraft(id: String) async throws
    /// nil keeps a property as it is; `flagIndex` 0–6 also flags the message.
    func setFlags(ids: [String], mailbox: String?, account: String?, read: Bool?, flagged: Bool?, flagIndex: Int?) async throws -> Int
    func move(ids: [String], mailbox: String?, account: String?, to: MailWave1.Destination) async throws -> Int
    /// Names (and MIME types, sizes) of a message's attachments, in order.
    func attachments(id: String, mailbox: String?, account: String?) async throws -> [(name: String, mimeType: String?, bytes: Int)]
    /// Saves attachment `index` (1-based) to `path`.
    func saveAttachment(id: String, mailbox: String?, account: String?, index: Int, to path: String) async throws
}

public protocol NotesBackend: Sendable {
    func list(folder: String?, limit: Int) async throws -> [NoteSummaryRecord]
    func read(id: String) async throws -> (NoteSummaryRecord, html: String, text: String)
    func create(title: String, html: String, folder: String?) async throws -> NoteSummaryRecord
    // Wave 1 (docs/connectors/apple-apps-2026.md §4.4).
    /// Matched by Notes (`whose`), newest modified first; each with the start of its plain text.
    func search(query: String, folder: String?, since: Date?, limit: Int) async throws -> [(NoteSummaryRecord, text: String)]
    func folders() async throws -> [NoteFolderRecord]
    func attachments(id: String) async throws -> [(id: String, name: String)]
    /// Appends HTML at the end; returns the note and its new body.
    func append(id: String, html: String) async throws -> (NoteSummaryRecord, html: String)
    /// Replaces the body and / or the name; returns the note and its body.
    func update(id: String, title: String?, html: String?) async throws -> (NoteSummaryRecord, html: String)
}

public protocol SafariBackend: Sendable {
    func tabs() async throws -> [SafariTabRecord]
    func open(_ url: URL) async throws
    // Wave 1 (docs/connectors/apple-apps-2026.md §4.7).
    /// A tab's text (Safari's own `text` of the tab; no JavaScript): the front window's current
    /// tab unless `window` / `index` are given.
    func tabText(window: Int?, index: Int?) async throws -> (SafariTabRecord, text: String)
    func addReadingList(_ url: URL, title: String?) async throws
}

/// Google Chrome tabs (S2): titles and URLs only (page text would need `execute`, never exposed).
public protocol ChromeBackend: Sendable {
    /// Empty when Chrome is not running (never launches it).
    func tabs() async throws -> [SafariTabRecord]
}

public protocol FinderBackend: Sendable {
    func reveal(_ path: String) async throws
}

// MARK: - Inputs

public struct CalendarEventInput: Decodable, Sendable {
    public var calendarId: String?
    public var title: String
    public var start: String
    public var end: String
    public var allDay: Bool?
    public var location: String?
    public var notes: String?
    public var url: String?
    // Wave 1 (C3).
    public var alarms: [AlarmSpec]?
    public var recurrence: RecurrenceSpec?
    public var availability: String?
}

public struct CalendarEventPatch: Decodable, Sendable {
    public var id: String
    public var title: String?
    public var start: String?
    public var end: String?
    public var allDay: Bool?
    public var location: String?
    public var notes: String?
    public var url: String?
    public var span: String?
    // Wave 1 (C3): `recurrence: null` removes it; absent leaves it.
    public var alarms: [AlarmSpec]?
    public var recurrence: RecurrenceSpec??
    public var availability: String?

    enum CodingKeys: String, CodingKey { case id, title, start, end, allDay, location, notes, url, span, alarms, recurrence, availability }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        start = try c.decodeIfPresent(String.self, forKey: .start)
        end = try c.decodeIfPresent(String.self, forKey: .end)
        allDay = try c.decodeIfPresent(Bool.self, forKey: .allDay)
        location = try c.decodeIfPresent(String.self, forKey: .location)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        span = try c.decodeIfPresent(String.self, forKey: .span)
        alarms = try c.decodeIfPresent([AlarmSpec].self, forKey: .alarms)
        recurrence = c.contains(.recurrence) ? .some(try c.decodeIfPresent(RecurrenceSpec.self, forKey: .recurrence)) : .none
        availability = try c.decodeIfPresent(String.self, forKey: .availability)
    }
}

public struct ReminderInput: Decodable, Sendable {
    public var listId: String?
    public var title: String
    public var notes: String?
    public var due: String?
    public var priority: Int?
    // Wave 1 (R2).
    public var url: String?
    public var alarm: AlarmSpec?
    public var recurrence: RecurrenceSpec?
}

public struct ReminderPatch: Decodable, Sendable {
    public var id: String
    public var title: String?
    public var notes: String?
    /// `null` clears the due date; absent leaves it.
    public var due: String??
    public var completed: Bool?
    public var priority: Int?

    enum CodingKeys: String, CodingKey { case id, title, notes, due, completed, priority }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        due = c.contains(.due) ? .some(try c.decodeIfPresent(String.self, forKey: .due)) : .none
        completed = try c.decodeIfPresent(Bool.self, forKey: .completed)
        priority = try c.decodeIfPresent(Int.self, forKey: .priority)
    }
}

public struct MailDraft: Decodable, Sendable, Equatable {
    public var to: [String]
    public var cc: [String]?
    public var subject: String
    public var body: String
}

// MARK: - EventKit

/// Calendars and Reminders through EventKit (full access, security §12: there is no read-only
/// event access). The first call asks for access (the TCC prompt names Psyche Helper).
public final class EventKitBackend: CalendarBackend, RemindersBackend, @unchecked Sendable {
    private let store = EKEventStore()

    public init() {}

    func ensure(_ type: EKEntityType) async throws {
        switch EKEventStore.authorizationStatus(for: type) {
        case .fullAccess: return
        case .notDetermined:
            try HostAttribution.check(type == .event ? .calendars : .reminders)  // #570
            if try await EventKitRequest.run(type, store: store) == "granted" { return }
        default: break
        }
        throw CapabilityError.permissionMissing(type == .event ? .calendars : .reminders)
    }

    static func record(_ c: EKCalendar) -> CalendarRecord {
        CalendarRecord(id: c.calendarIdentifier, title: c.title, source: c.source?.title ?? "", writable: c.allowsContentModifications,
                       color: c.cgColor.flatMap { col in
                           guard let comps = col.components, comps.count >= 3 else { return nil }
                           return String(format: "#%02X%02X%02X", Int(comps[0] * 255), Int(comps[1] * 255), Int(comps[2] * 255))
                       })
    }

    static func record(_ e: EKEvent) -> CalendarEventRecord {
        CalendarEventRecord(id: e.calendarItemIdentifier, calendarId: e.calendar?.calendarIdentifier ?? "", title: e.title ?? "",
                    start: AppleDates.string(e.startDate), end: AppleDates.string(e.endDate), allDay: e.isAllDay,
                    location: e.location, notes: e.notes, url: e.url?.absoluteString, recurring: e.hasRecurrenceRules,
                    attendees: (e.attendees ?? []).map { Self.attendee($0, organizer: e.organizer) },
                    conferenceUrl: ConferenceLinks.find([e.url?.absoluteString, e.location, e.notes]),
                    alarms: (e.alarms ?? []).compactMap(Self.alarm), recurrence: e.recurrenceRules?.first.map(Self.recurrence),
                    availability: Self.availability(e.availability))
    }

    static func record(_ r: EKReminder) -> ReminderRecord {
        ReminderRecord(id: r.calendarItemIdentifier, listId: r.calendar?.calendarIdentifier ?? "", title: r.title ?? "", notes: r.notes,
                       due: r.dueDateComponents.flatMap { Calendar.current.date(from: $0) }.map(AppleDates.string), completed: r.isCompleted,
                       priority: r.priority, url: r.url?.absoluteString, alarms: (r.alarms ?? []).compactMap(Self.alarm),
                       recurrence: r.recurrenceRules?.first.map(Self.recurrence))
    }

    // MARK: Wave 1 mapping (alarms, recurrence, attendees, availability)

    static func alarm(_ a: EKAlarm) -> AlarmSpec? {
        if let d = a.absoluteDate { return .absolute(AppleDates.string(d)) }
        return .relative(minutes: min(0, Int((a.relativeOffset / 60).rounded())))
    }

    static func ekAlarm(_ a: AlarmSpec) throws -> EKAlarm {
        switch a {
        case .relative(let m): return EKAlarm(relativeOffset: TimeInterval(m * 60))
        case .absolute(let at): return EKAlarm(absoluteDate: try AppleDates.param(at, field: "alarm.at"))
        }
    }

    static let frequencies: [EKRecurrenceFrequency: String] = [.daily: "daily", .weekly: "weekly", .monthly: "monthly", .yearly: "yearly"]

    static func recurrence(_ r: EKRecurrenceRule) -> RecurrenceSpec {
        RecurrenceSpec(
            frequency: frequencies[r.frequency] ?? "daily", interval: r.interval == 1 ? nil : r.interval,
            daysOfWeek: r.daysOfTheWeek.map { $0.map { RecurrenceSpec.days[max(0, $0.dayOfTheWeek.rawValue - 1)] } },
            until: r.recurrenceEnd?.endDate.map(AppleDates.string),
            count: r.recurrenceEnd.flatMap { $0.occurrenceCount > 0 ? $0.occurrenceCount : nil })
    }

    static func ekRecurrence(_ r: RecurrenceSpec) throws -> EKRecurrenceRule {
        try r.validate()
        let freq = frequencies.first { $0.value == r.frequency }?.key ?? .daily
        let days = r.daysOfWeek?.compactMap { d -> EKRecurrenceDayOfWeek? in
            guard let i = RecurrenceSpec.days.firstIndex(of: d), let w = EKWeekday(rawValue: i + 1) else { return nil }
            return EKRecurrenceDayOfWeek(w)
        }
        let end: EKRecurrenceEnd? = try r.until.map { EKRecurrenceEnd(end: try AppleDates.param($0, field: "recurrence.until")) }
            ?? r.count.map { EKRecurrenceEnd(occurrenceCount: $0) }
        return EKRecurrenceRule(recurrenceWith: freq, interval: r.interval ?? 1, daysOfTheWeek: days, daysOfTheMonth: nil,
                                monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: end)
    }

    static func availability(_ a: EKEventAvailability) -> String? {
        switch a {
        case .busy: "busy"
        case .free: "free"
        case .tentative: "tentative"
        case .unavailable: "unavailable"
        default: nil
        }
    }

    static func attendee(_ p: EKParticipant, organizer: EKParticipant?) -> AttendeeRecord {
        let email = p.url.absoluteString.lowercased().hasPrefix("mailto:") ? String(p.url.absoluteString.dropFirst(7)) : nil
        let status: String
        switch p.participantStatus {
        case .accepted: status = "accepted"
        case .declined: status = "declined"
        case .tentative: status = "tentative"
        case .pending: status = "pending"
        default: status = "unknown"
        }
        return AttendeeRecord(name: p.name ?? email ?? "", email: email, status: status, organizer: organizer.map { $0.url == p.url } ?? false)
    }

    static func checkAlarms(_ xs: [AlarmSpec]?) throws {
        if let xs, xs.count > 5 { throw CapabilityError.invalidParams("at most 5 alarms", field: "alarms") }
    }

    func calendars(_ ids: [String]?, type: EKEntityType) -> [EKCalendar]? {
        guard let ids else { return nil }
        return store.calendars(for: type).filter { ids.contains($0.calendarIdentifier) }
    }

    static func saveError(_ error: Error) -> CapabilityError {
        CapabilityError(.unavailable, reason: "eventkit_save", "Calendar could not save the item (\((error as NSError).code))")
    }

    // Calendar
    public func calendars() async throws -> [CalendarRecord] {
        try await ensure(.event)
        return store.calendars(for: .event).map(Self.record)
    }

    public func events(from: Date, to: Date, calendarIds: [String]?, query: String?, limit: Int) async throws -> [CalendarEventRecord] {
        try await ensure(.event)
        let pred = store.predicateForEvents(withStart: from, end: to, calendars: calendars(calendarIds, type: .event))
        let q = (query ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        return store.events(matching: pred).filter { e in
            q.isEmpty || [e.title, e.location, e.notes].contains { ($0 ?? "").lowercased().contains(q) }
        }.sorted { $0.startDate < $1.startDate }.prefix(limit).map(Self.record)
    }

    public func freeBusy(from: Date, to: Date, calendarIds: [String]?) async throws -> [BusyBlockRecord] {
        try await ensure(.event)
        let pred = store.predicateForEvents(withStart: from, end: to, calendars: calendars(calendarIds, type: .event))
        return BusyBlockRecord.blocks(store.events(matching: pred).map {
            BusyBlockRecord(start: AppleDates.string($0.startDate), end: AppleDates.string($0.endDate), calendarId: $0.calendar?.calendarIdentifier ?? "",
                            availability: Self.availability($0.availability) ?? "busy")
        })
    }

    public func deleteEvent(id: String, span: String?) async throws {
        try await ensure(.event)
        guard let e = store.calendarItem(withIdentifier: id) as? EKEvent else {
            throw CapabilityError(.notFound, reason: "event_not_found", "No event \(id)")
        }
        guard e.calendar?.allowsContentModifications ?? false else { throw CapabilityError(.forbidden, reason: "calendar_read_only", "The event's calendar is read-only") }
        do { try store.remove(e, span: span == "future" ? .futureEvents : .thisEvent, commit: true) } catch { throw Self.saveError(error) }
    }

    func apply(_ e: EKEvent, title: String?, start: String?, end: String?, allDay: Bool?, location: String?, notes: String?, url: String?) throws {
        if let title { e.title = title }
        if let start { e.startDate = try AppleDates.param(start, field: "start") }
        if let end { e.endDate = try AppleDates.param(end, field: "end") }
        if let allDay { e.isAllDay = allDay }
        if let location { e.location = location }
        if let notes { e.notes = notes }
        if let url { e.url = URL(string: url) }
        guard e.endDate >= e.startDate else { throw CapabilityError.invalidParams("end is before start", field: "end") }
    }

    /// Alarms replace the existing ones; `recurrence` `.some(nil)` removes it; availability busy / free.
    func applyWave1(_ e: EKEvent, alarms: [AlarmSpec]?, recurrence: RecurrenceSpec??, availability: String?) throws {
        try Self.checkAlarms(alarms)
        if let alarms { e.alarms = try alarms.map(Self.ekAlarm) }
        if case .some(let r) = recurrence { e.recurrenceRules = try r.map { [try Self.ekRecurrence($0)] } }
        if let a = availability {
            guard a == "busy" || a == "free" else { throw CapabilityError.invalidParams("availability is busy or free", field: "availability") }
            e.availability = a == "busy" ? .busy : .free
        }
    }

    public func create(_ input: CalendarEventInput) async throws -> CalendarEventRecord {
        try await ensure(.event)
        let e = EKEvent(eventStore: store)
        guard let cal = input.calendarId.flatMap({ store.calendar(withIdentifier: $0) }) ?? store.defaultCalendarForNewEvents else {
            throw CapabilityError(.notFound, reason: "calendar_not_found", "No such calendar")
        }
        guard cal.allowsContentModifications else { throw CapabilityError(.forbidden, reason: "calendar_read_only", "\(cal.title) is read-only") }
        e.calendar = cal
        try apply(e, title: input.title, start: input.start, end: input.end, allDay: input.allDay, location: input.location, notes: input.notes, url: input.url)
        try applyWave1(e, alarms: input.alarms, recurrence: input.recurrence.map { .some($0) } ?? .none, availability: input.availability)
        do { try store.save(e, span: .thisEvent, commit: true) } catch { throw Self.saveError(error) }
        return Self.record(e)
    }

    public func update(_ p: CalendarEventPatch) async throws -> CalendarEventRecord {
        try await ensure(.event)
        guard let e = store.calendarItem(withIdentifier: p.id) as? EKEvent else {
            throw CapabilityError(.notFound, reason: "event_not_found", "No event \(p.id)")
        }
        try apply(e, title: p.title, start: p.start, end: p.end, allDay: p.allDay, location: p.location, notes: p.notes, url: p.url)
        try applyWave1(e, alarms: p.alarms, recurrence: p.recurrence, availability: p.availability)
        do { try store.save(e, span: p.span == "future" ? .futureEvents : .thisEvent, commit: true) } catch { throw Self.saveError(error) }
        return Self.record(e)
    }

    // Reminders
    public func lists() async throws -> [CalendarRecord] {
        try await ensure(.reminder)
        return store.calendars(for: .reminder).map(Self.record)
    }

    struct Box: @unchecked Sendable { let items: [EKReminder] }

    public func reminders(listIds: [String]?, completed: Bool?, dueBefore: Date?, filter: ReminderQuery, limit: Int) async throws -> [ReminderRecord] {
        try await ensure(.reminder)
        let cals = calendars(listIds, type: .reminder)
        let pred: NSPredicate =
            switch completed {
            case true?: store.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: cals)
            case false?: store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: dueBefore, calendars: cals)
            case nil: store.predicateForReminders(in: cals)
            }
        let box: Box = await withCheckedContinuation { c in store.fetchReminders(matching: pred) { c.resume(returning: Box(items: $0 ?? [])) } }
        let items = box.items.map(Self.record).filter { r in
            guard let dueBefore else { return true }
            return r.due.flatMap(AppleDates.parse).map { $0 <= dueBefore } ?? false
        }
        return filter.apply(items, now: Date(), limit: limit)
    }

    static func components(_ iso: String) throws -> DateComponents {
        let d = try AppleDates.param(iso, field: "due")
        return Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: d)
    }

    public func create(_ input: ReminderInput) async throws -> ReminderRecord {
        try await ensure(.reminder)
        let r = EKReminder(eventStore: store)
        guard let cal = input.listId.flatMap({ store.calendar(withIdentifier: $0) }) ?? store.defaultCalendarForNewReminders() else {
            throw CapabilityError(.notFound, reason: "list_not_found", "No such reminders list")
        }
        r.calendar = cal
        r.title = input.title
        r.notes = input.notes
        if let due = input.due { r.dueDateComponents = try Self.components(due) }
        if let p = input.priority { r.priority = p }
        if let u = input.url { r.url = URL(string: u) }
        if let a = input.alarm { r.alarms = [try Self.ekAlarm(a)] }
        if let rec = input.recurrence {
            guard input.due != nil else { throw CapabilityError.invalidParams("a repeating reminder needs a due date", field: "recurrence") }
            r.recurrenceRules = [try Self.ekRecurrence(rec)]
        }
        do { try store.save(r, commit: true) } catch { throw Self.saveError(error) }
        return Self.record(r)
    }

    public func update(_ p: ReminderPatch) async throws -> ReminderRecord {
        try await ensure(.reminder)
        guard let r = store.calendarItem(withIdentifier: p.id) as? EKReminder else {
            throw CapabilityError(.notFound, reason: "reminder_not_found", "No reminder \(p.id)")
        }
        if let t = p.title { r.title = t }
        if let n = p.notes { r.notes = n }
        if case .some(let due) = p.due { r.dueDateComponents = try due.map(Self.components) }
        if let c = p.completed { r.isCompleted = c }
        if let pr = p.priority { r.priority = pr }
        do { try store.save(r, commit: true) } catch { throw Self.saveError(error) }
        return Self.record(r)
    }

    // MARK: Reminders wave 1 (R3–R5)

    public func complete(id: String?, title: String?, listId: String?, completed: Bool) async throws -> ReminderRecord {
        try await ensure(.reminder)
        let r: EKReminder
        if let id {
            guard let found = store.calendarItem(withIdentifier: id) as? EKReminder else {
                throw CapabilityError(.notFound, reason: "reminder_not_found", "No reminder \(id)")
            }
            r = found
        } else {
            let t = (title ?? "").trimmingCharacters(in: .whitespaces)
            let cals = listId.map { calendars([$0], type: .reminder) ?? [] }
            let pred = completed ? store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: cals)
                : store.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: cals)
            let box: Box = await withCheckedContinuation { c in store.fetchReminders(matching: pred) { c.resume(returning: Box(items: $0 ?? [])) } }
            let matches = box.items.filter { ($0.title ?? "") == t }
            guard let one = matches.first else { throw CapabilityError(.notFound, reason: "reminder_not_found", "No \(completed ? "open" : "completed") reminder titled \(t)") }
            guard matches.count == 1 else {
                throw CapabilityError(.conflict, reason: "reminder_ambiguous", "\(matches.count) reminders are titled \(t); give its id or a listId",
                                      details: ["ids": .array(matches.map { .string($0.calendarItemIdentifier) })])
            }
            r = one
        }
        r.isCompleted = completed
        do { try store.save(r, commit: true) } catch { throw Self.saveError(error) }
        return Self.record(r)
    }

    public func delete(id: String) async throws {
        try await ensure(.reminder)
        guard let r = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw CapabilityError(.notFound, reason: "reminder_not_found", "No reminder \(id)")
        }
        do { try store.remove(r, commit: true) } catch { throw Self.saveError(error) }
    }

    static let remindersApp = "com.apple.reminders"
    static let flagScript = ScriptHandler.prelude + """
        on psyche_flagged()
          tell application "Reminders"
            set ids to id of (reminders whose flagged is true and completed is false)
          end tell
          return my psyche_join(ids, character id 30)
        end psyche_flagged
        on psyche_set_flagged(rid, f)
          tell application "Reminders"
            set flagged of reminder id ("x-apple-reminder://" & rid) to (f is "true")
          end tell
          return "ok"
        end psyche_set_flagged
        """

    public func setFlagged(id: String, flagged: Bool) async throws {
        guard !id.isEmpty, !id.contains("/"), id.count <= 200 else { throw CapabilityError.invalidParams("id is a reminder id", field: "id") }
        _ = try await ScriptHandler.call(Self.flagScript, handler: "psyche_set_flagged", [id, flagged ? "true" : "false"], app: Self.remindersApp)
    }

    public func flaggedIds() async throws -> Set<String> {
        let out = try await ScriptHandler.call(Self.flagScript, handler: "psyche_flagged", [], app: Self.remindersApp)
        return Set((out ?? "").components(separatedBy: "\u{1E}").filter { !$0.isEmpty }.map(ReminderQuery.eventKitId))
    }
}

// MARK: - Scripting (Mail, Notes, Safari)

/// Runs a constant AppleScript handler with string/list arguments on the main thread. Inputs are
/// arguments, never spliced into source, so app content and model text cannot become script.
enum ScriptHandler {
    /// The handler's arguments (strings and string lists) crossing to the main queue.
    final class ArgumentsBox: @unchecked Sendable {
        let args: [Any]
        init(_ args: [Any]) { self.args = args }
    }

    static func call(_ source: String, handler: String, _ args: [Any], app bundleId: String) async throws -> String? {
        try await ensureRunning(bundleId)
        try await AutomationPermission.ensure(bundleId: bundleId, ask: true)
        // Plain strings and string lists, read only on the main queue: safe to hand over.
        let box = ArgumentsBox(args)
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String?, Error>) in
            DispatchQueue.main.async {
                guard let lang = OSALanguage(forName: "AppleScript") else {
                    cont.resume(throwing: CapabilityError.unavailable("osa_language_missing", "AppleScript is not available"))
                    return
                }
                let script = OSAScript(source: source, language: lang)
                var error: NSDictionary?
                let result = script.executeHandler(withName: handler, arguments: box.args, error: &error)
                if let error {
                    let number = (error[OSAScriptErrorNumberKey] as? NSNumber)?.intValue ?? 0
                    switch number {
                    case -1743: cont.resume(throwing: CapabilityError(.forbidden, reason: "automation_denied", "Automation was denied for \(bundleId)", details: ["permission": "automation", "target": .string(bundleId)]))
                    case -1728, -1719: cont.resume(throwing: CapabilityError(.notFound, reason: "not_found", "The item was not found"))
                    default: cont.resume(throwing: CapabilityError(.unavailable, reason: "script_error", "The app could not complete the request", details: ["osaError": .int(number)]))
                    }
                    return
                }
                cont.resume(returning: result?.stringValue)
            }
        }
    }

    /// Launches the target in the background when needed (Automation can only be asked of a running app).
    static func ensureRunning(_ bundleId: String) async throws {
        if NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
                throw CapabilityError(.notFound, reason: "app_not_installed", "\(bundleId) is not installed")
            }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = false
            config.hides = true
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
            try await _Concurrency.Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    /// Shared helpers: strip the record separators from text and join records.
    static let prelude = """
        on psyche_clean(t)
          set AppleScript's text item delimiters to {character id 30, character id 31}
          set parts to text items of (t as text)
          set AppleScript's text item delimiters to " "
          set r to parts as text
          set AppleScript's text item delimiters to ""
          return r
        end psyche_clean
        on psyche_join(xs, d)
          set AppleScript's text item delimiters to d
          set r to xs as text
          set AppleScript's text item delimiters to ""
          return r
        end psyche_join
        on psyche_iso(d)
          return (d as «class isot» as string)
        end psyche_iso

        """
}

public final class MailScriptingBackend: MailBackend, @unchecked Sendable {
    static let bundleId = "com.apple.mail"
    static let source = ScriptHandler.prelude + """
        on psyche_source(mboxName, acctName)
          tell application "Mail"
            if acctName is "" then return inbox
            return mailbox mboxName of account acctName
          end tell
        end psyche_source
        on psyche_line(m)
          set fs to character id 31
          tell application "Mail"
            return (id of m as text) & fs & my psyche_clean(name of mailbox of m) & fs & my psyche_clean(name of account of mailbox of m) & fs & my psyche_clean(subject of m) & fs & my psyche_clean(sender of m) & fs & my psyche_iso(date received of m) & fs & (read status of m as text) & fs & (flagged status of m as text) & fs & my psyche_clean(message id of m)
          end tell
        end psyche_line
        on psyche_date(parts)
          set dt to current date
          set day of dt to 1
          set year of dt to (item 1 of parts as integer)
          set month of dt to (item 2 of parts as integer)
          set day of dt to (item 3 of parts as integer)
          set time of dt to (item 4 of parts as integer)
          return dt
        end psyche_date
        -- #626: every filter is evaluated by Mail in one whose clause. The script text is fixed;
        -- the inputs are handler arguments. An unused text filter picks another variant (an
        -- empty "contains" is not reliable in Mail), the date window is always applied, and
        -- "read status is r1 or read status is r2" covers unread / read / both.
        on psyche_match(q, f, rs1, rs2, sinceParts, untilParts, mboxName, acctName)
          set s to my psyche_date(sinceParts)
          set u to my psyche_date(untilParts)
          set r1 to (rs1 is "true")
          set r2 to (rs2 is "true")
          set fs to character id 31
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            if q is not "" and f is not "" then
              set ids to id of (messages of src whose (subject contains q or sender contains q) and sender contains f and date received ≥ s and date received < u and (read status is r1 or read status is r2))
              set ds to date received of (messages of src whose (subject contains q or sender contains q) and sender contains f and date received ≥ s and date received < u and (read status is r1 or read status is r2))
            else if q is not "" then
              set ids to id of (messages of src whose (subject contains q or sender contains q) and date received ≥ s and date received < u and (read status is r1 or read status is r2))
              set ds to date received of (messages of src whose (subject contains q or sender contains q) and date received ≥ s and date received < u and (read status is r1 or read status is r2))
            else if f is not "" then
              set ids to id of (messages of src whose sender contains f and date received ≥ s and date received < u and (read status is r1 or read status is r2))
              set ds to date received of (messages of src whose sender contains f and date received ≥ s and date received < u and (read status is r1 or read status is r2))
            else
              set ids to id of (messages of src whose date received ≥ s and date received < u and (read status is r1 or read status is r2))
              set ds to date received of (messages of src whose date received ≥ s and date received < u and (read status is r1 or read status is r2))
            end if
          end tell
          set out to {}
          repeat with i from 1 to (count of ids)
            set end of out to ((item i of ids) as text) & fs & my psyche_iso(item i of ds)
          end repeat
          return my psyche_join(out, character id 30)
        end psyche_match
        on psyche_lines(idList, mboxName, acctName)
          set out to {}
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            repeat with mid in idList
              set m to first message of src whose id is (mid as integer)
              set end of out to my psyche_line(m)
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_lines
        on psyche_read(mid, mboxName, acctName, maxLen)
          set fs to character id 31
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            set m to first message of src whose id is (mid as integer)
            set tos to {}
            repeat with r in to recipients of m
              set end of tos to my psyche_clean(address of r)
            end repeat
            set ccs to {}
            repeat with r in cc recipients of m
              set end of ccs to my psyche_clean(address of r)
            end repeat
            set b to my psyche_clean(content of m)
          end tell
          if (length of b) > (maxLen as integer) then set b to text 1 thru (maxLen as integer) of b
          return my psyche_line(m) & fs & my psyche_join(tos, character id 29) & fs & my psyche_join(ccs, character id 29) & fs & b
        end psyche_read
        on psyche_compose(toList, ccList, subj, bodyText, mode)
          tell application "Mail"
            set msg to make new outgoing message with properties {subject:subj, content:bodyText, visible:false}
            tell msg
              repeat with a in toList
                make new to recipient at end of to recipients with properties {address:(a as text)}
              end repeat
              repeat with a in ccList
                make new cc recipient at end of cc recipients with properties {address:(a as text)}
              end repeat
            end tell
            if mode is "send" then
              send msg
              return "sent"
            else
              save msg
              return my psyche_outgoing(msg)
            end if
          end tell
        end psyche_compose
        -- Wave 1 (docs/connectors/apple-apps-2026.md §4.1, M2–M9). Fixed text; inputs are arguments.
        on psyche_outgoing(r)
          set fs to character id 31
          tell application "Mail"
            set tos to {}
            repeat with x in to recipients of r
              set end of tos to my psyche_clean(address of x)
            end repeat
            set ccs to {}
            repeat with x in cc recipients of r
              set end of ccs to my psyche_clean(address of x)
            end repeat
            set subj to subject of r
            if subj is missing value then set subj to ""
            set b to content of r
            if b is missing value then set b to ""
            return (id of r as text) & fs & my psyche_clean(subj) & fs & my psyche_join(tos, character id 29) & fs & my psyche_join(ccs, character id 29) & fs & my psyche_clean(b)
          end tell
        end psyche_outgoing
        on psyche_mailbox_path(mb)
          tell application "Mail"
            set nm to name of mb
            set c to mb
            repeat 8 times
              try
                set c to container of c
                if class of c is not mailbox then exit repeat
                set nm to (name of c) & "/" & nm
              on error
                exit repeat
              end try
            end repeat
          end tell
          return nm
        end psyche_mailbox_path
        on psyche_mailboxes(acctName)
          set fs to character id 31
          set out to {}
          tell application "Mail"
            if acctName is "" then set end of out to "" & fs & "INBOX" & fs & (unread count of inbox as text)
            repeat with a in accounts
              if acctName is "" or (name of a) is acctName then
                repeat with mb in mailboxes of a
                  set end of out to my psyche_clean(name of a) & fs & my psyche_clean(my psyche_mailbox_path(mb)) & fs & (unread count of mb as text)
                end repeat
              end if
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_mailboxes
        on psyche_selected(lim)
          set out to {}
          tell application "Mail"
            if (count of message viewers) is 0 then return ""
            set sel to selected messages of front message viewer
            if sel is missing value then return ""
            set n to 0
            repeat with m in sel
              if n ≥ (lim as integer) then exit repeat
              set end of out to my psyche_line(m)
              set n to n + 1
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_selected
        on psyche_reply(mid, mboxName, acctName, bodyText, replyAll, ccList)
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            set m to first message of src whose id is (mid as integer)
            if replyAll is "true" then
              set r to reply m with reply to all without opening window
            else
              set r to reply m without opening window
            end if
            tell r
              repeat with a in ccList
                make new cc recipient at end of cc recipients with properties {address:(a as text)}
              end repeat
            end tell
            set content of r to bodyText & return & return & (content of r)
            save r
            return my psyche_outgoing(r)
          end tell
        end psyche_reply
        on psyche_forward(mid, mboxName, acctName, toList, ccList, bodyText)
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            set m to first message of src whose id is (mid as integer)
            set r to forward m without opening window
            tell r
              repeat with a in toList
                make new to recipient at end of to recipients with properties {address:(a as text)}
              end repeat
              repeat with a in ccList
                make new cc recipient at end of cc recipients with properties {address:(a as text)}
              end repeat
            end tell
            set content of r to bodyText & return & return & (content of r)
            save r
            return my psyche_outgoing(r)
          end tell
        end psyche_forward
        on psyche_draft(did)
          tell application "Mail"
            set found to (outgoing messages whose id is (did as integer))
            if (count of found) is 0 then return ""
            return my psyche_outgoing(item 1 of found)
          end tell
        end psyche_draft
        on psyche_send_draft(did)
          tell application "Mail"
            send (first outgoing message whose id is (did as integer))
          end tell
          return "sent"
        end psyche_send_draft
        on psyche_flags(idList, mboxName, acctName, readMode, flagMode, flagIdx)
          set n to 0
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            repeat with mid in idList
              set m to first message of src whose id is (mid as integer)
              if readMode is "true" then set read status of m to true
              if readMode is "false" then set read status of m to false
              if flagMode is "false" then set flagged status of m to false
              if flagMode is "true" then set flagged status of m to true
              if flagIdx is not "-1" then set flag index of m to (flagIdx as integer)
              set n to n + 1
            end repeat
          end tell
          return n as text
        end psyche_flags
        on psyche_move(idList, mboxName, acctName, destKind, destName, destAcct)
          set n to 0
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            repeat with mid in idList
              set m to first message of src whose id is (mid as integer)
              if destKind is "archive" then
                set target to mailbox "Archive" of account of mailbox of m
              else if destKind is "junk" then
                set junk mail status of m to true
                set target to junk mailbox
              else
                set target to mailbox destName of account destAcct
              end if
              move m to target
              set n to n + 1
            end repeat
          end tell
          return n as text
        end psyche_move
        on psyche_attachments(mid, mboxName, acctName)
          set fs to character id 31
          set out to {}
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            set m to first message of src whose id is (mid as integer)
            repeat with a in mail attachments of m
              set t to ""
              try
                set t to MIME type of a
              end try
              set sz to 0
              try
                set sz to file size of a
              end try
              set end of out to my psyche_clean(name of a) & fs & my psyche_clean(t) & fs & (sz as text)
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_attachments
        on psyche_save_attachment(mid, mboxName, acctName, idx, destPath)
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            set m to first message of src whose id is (mid as integer)
            save (mail attachment (idx as integer) of m) in (POSIX file destPath)
          end tell
          return "saved"
        end psyche_save_attachment
        """

    public init() {}

    /// `psyche_line`: id, mailbox, account, subject, sender, date, read, flagged, Message-ID.
    static let lineFields = 9

    static func summary(_ f: [String]) -> MailSummaryRecord {
        MailSummaryRecord(id: f[0], mailbox: f[1], account: f[2], subject: f[3], from: f[4],
                          date: AppleDates.fromAppleScript(f[5]) ?? AppleDates.string(Date(timeIntervalSince1970: 0)), read: f[6] == "true",
                          flagged: f[7] == "true", link: MailWave1.link(messageId: f[8]))
    }

    public func search(_ filter: MailSearchFilter, mailbox: String?, account: String?, limit: Int) async throws -> [MailSummaryRecord] {
        let (rs1, rs2) = filter.readStatus
        let matches = try await ScriptHandler.call(
            Self.source, handler: "psyche_match",
            [filter.query, filter.from, rs1, rs2, filter.sinceParts(), filter.untilParts(), mailbox ?? "", account ?? ""],
            app: Self.bundleId)
        // Newest first: Mail's own order is per mailbox, so sort the matches' dates here and
        // read only the `limit` newest messages.
        let ids = MailSearchFilter.newest(ScriptRecords.parse(matches, fields: 2), limit: limit)
        if ids.isEmpty { return [] }
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_lines", [ids, mailbox ?? "", account ?? ""], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: Self.lineFields).map(Self.summary)
    }

    public func read(id: String, mailbox: String?, account: String?, maxLength: Int) async throws -> (MailSummaryRecord, to: [String], cc: [String], body: String) {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_read", [id, mailbox ?? "", account ?? "", "\(maxLength)"], app: Self.bundleId)
        let n = Self.lineFields
        guard let f = ScriptRecords.parse(out, fields: n + 3).first else { throw CapabilityError(.notFound, reason: "message_not_found", "No message \(id)") }
        let split: (String) -> [String] = { $0.isEmpty ? [] : $0.components(separatedBy: "\u{1D}") }
        return (Self.summary(Array(f[0..<n])), split(f[n]), split(f[n + 1]), f[n + 2])
    }

    @discardableResult
    public func compose(_ draft: MailDraft, send: Bool) async throws -> MailDraftRecord? {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_compose",
                                               [draft.to, draft.cc ?? [], draft.subject, draft.body, send ? "send" : "draft"], app: Self.bundleId)
        return send ? nil : Self.draftRecord(out)
    }

    // MARK: Wave 1

    static func draftRecord(_ out: String?) -> MailDraftRecord? {
        guard let f = ScriptRecords.parse(out, fields: 5).first else { return nil }
        let split: (String) -> [String] = { $0.isEmpty ? [] : $0.components(separatedBy: "\u{1D}") }
        return MailDraftRecord(draftId: f[0], subject: f[1], to: split(f[2]), cc: split(f[3]), body: f[4])
    }

    public func mailboxes(account: String?) async throws -> [MailboxRecord] {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_mailboxes", [account ?? ""], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: 3).map { MailboxRecord(account: $0[0], name: $0[1], unreadCount: Int($0[2]) ?? 0) }
    }

    public func selected(limit: Int) async throws -> [MailSummaryRecord] {
        // "This email" means the one on screen: never launch Mail just to find nothing selected.
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleId).isEmpty else { return [] }
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_selected", ["\(limit)"], app: Self.bundleId)
        return MailWave1.newestFirst(ScriptRecords.parse(out, fields: Self.lineFields).map(Self.summary))
    }

    func draftOrThrow(_ out: String?) throws -> MailDraftRecord {
        guard let d = Self.draftRecord(out) else { throw CapabilityError(.unavailable, reason: "script_error", "Mail did not return the draft") }
        return d
    }

    public func replyDraft(id: String, mailbox: String?, account: String?, body: String, replyAll: Bool, cc: [String]) async throws -> MailDraftRecord {
        try draftOrThrow(try await ScriptHandler.call(Self.source, handler: "psyche_reply",
                                                      [id, mailbox ?? "", account ?? "", body, replyAll ? "true" : "false", cc], app: Self.bundleId))
    }

    public func forwardDraft(id: String, mailbox: String?, account: String?, to: [String], cc: [String], body: String) async throws -> MailDraftRecord {
        try draftOrThrow(try await ScriptHandler.call(Self.source, handler: "psyche_forward",
                                                      [id, mailbox ?? "", account ?? "", to, cc, body], app: Self.bundleId))
    }

    public func draft(id: String) async throws -> MailDraftRecord? {
        Self.draftRecord(try await ScriptHandler.call(Self.source, handler: "psyche_draft", [id], app: Self.bundleId))
    }

    public func sendDraft(id: String) async throws {
        _ = try await ScriptHandler.call(Self.source, handler: "psyche_send_draft", [id], app: Self.bundleId)
    }

    public func setFlags(ids: [String], mailbox: String?, account: String?, read: Bool?, flagged: Bool?, flagIndex: Int?) async throws -> Int {
        let mode: (Bool?) -> String = { $0.map { $0 ? "true" : "false" } ?? "" }
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_flags",
                                               [ids, mailbox ?? "", account ?? "", mode(read), mode(flagged), "\(flagIndex ?? -1)"], app: Self.bundleId)
        return Int(out ?? "") ?? 0
    }

    public func move(ids: [String], mailbox: String?, account: String?, to: MailWave1.Destination) async throws -> Int {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_move", [ids, mailbox ?? "", account ?? ""] + to.scriptArgs, app: Self.bundleId)
        return Int(out ?? "") ?? 0
    }

    public func attachments(id: String, mailbox: String?, account: String?) async throws -> [(name: String, mimeType: String?, bytes: Int)] {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_attachments", [id, mailbox ?? "", account ?? ""], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: 3).map { (name: $0[0], mimeType: $0[1].isEmpty ? nil : $0[1], bytes: Int($0[2]) ?? 0) }
    }

    public func saveAttachment(id: String, mailbox: String?, account: String?, index: Int, to path: String) async throws {
        _ = try await ScriptHandler.call(Self.source, handler: "psyche_save_attachment", [id, mailbox ?? "", account ?? "", "\(index)", path], app: Self.bundleId)
    }
}

public final class NotesScriptingBackend: NotesBackend, @unchecked Sendable {
    static let bundleId = "com.apple.Notes"
    static let source = ScriptHandler.prelude + """
        on psyche_line(n)
          set fs to character id 31
          tell application "Notes"
            return (id of n as text) & fs & my psyche_clean(name of container of n) & fs & my psyche_clean(name of n) & fs & my psyche_iso(modification date of n)
          end tell
        end psyche_line
        on psyche_list(folderName, lim)
          set out to {}
          tell application "Notes"
            if folderName is "" then
              set ns to notes
            else
              set ns to notes of folder folderName
            end if
            repeat with n in ns
              if (count of out) ≥ (lim as integer) then exit repeat
              set end of out to my psyche_line(n)
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_list
        on psyche_read(nid)
          set fs to character id 31
          tell application "Notes"
            set n to note id nid
            return my psyche_line(n) & fs & my psyche_clean(body of n) & fs & my psyche_clean(plaintext of n)
          end tell
        end psyche_read
        on psyche_create(html, folderName)
          tell application "Notes"
            if folderName is "" then
              set n to make new note with properties {body:html}
            else
              set n to make new note at folder folderName with properties {body:html}
            end if
            return my psyche_line(n)
          end tell
        end psyche_create
        -- Wave 1 (docs/connectors/apple-apps-2026.md §4.4, N1–N4). Fixed text; inputs are arguments.
        on psyche_date(parts)
          set dt to current date
          set day of dt to 1
          set year of dt to (item 1 of parts as integer)
          set month of dt to (item 2 of parts as integer)
          set day of dt to (item 3 of parts as integer)
          set time of dt to (item 4 of parts as integer)
          return dt
        end psyche_date
        on psyche_search(q, folderName, sinceParts)
          set s to my psyche_date(sinceParts)
          set fs to character id 31
          tell application "Notes"
            if folderName is "" and q is "" then
              set ids to id of (notes whose modification date ≥ s)
              set ds to modification date of (notes whose modification date ≥ s)
            else if folderName is "" then
              set ids to id of (notes whose (name contains q or plaintext contains q) and modification date ≥ s)
              set ds to modification date of (notes whose (name contains q or plaintext contains q) and modification date ≥ s)
            else if q is "" then
              set ids to id of (notes of folder folderName whose modification date ≥ s)
              set ds to modification date of (notes of folder folderName whose modification date ≥ s)
            else
              set ids to id of (notes of folder folderName whose (name contains q or plaintext contains q) and modification date ≥ s)
              set ds to modification date of (notes of folder folderName whose (name contains q or plaintext contains q) and modification date ≥ s)
            end if
          end tell
          set out to {}
          repeat with i from 1 to (count of ids)
            set end of out to ((item i of ids) as text) & fs & my psyche_iso(item i of ds)
          end repeat
          return my psyche_join(out, character id 30)
        end psyche_search
        on psyche_lines(idList, maxChars)
          set fs to character id 31
          set out to {}
          tell application "Notes"
            repeat with nid in idList
              set n to note id (nid as text)
              set t to my psyche_clean(plaintext of n)
              if (length of t) > (maxChars as integer) then set t to text 1 thru (maxChars as integer) of t
              set end of out to my psyche_line(n) & fs & t
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_lines
        on psyche_walk(f, acctName, pid, out)
          set fs to character id 31
          tell application "Notes"
            set end of out to (id of f as text) & fs & my psyche_clean(name of f) & fs & my psyche_clean(acctName) & fs & pid & fs & ((count of notes of f) as text)
            repeat with g in folders of f
              my psyche_walk(g, acctName, (id of f as text), out)
            end repeat
          end tell
        end psyche_walk
        on psyche_folders()
          set out to {}
          tell application "Notes"
            repeat with a in accounts
              repeat with f in folders of a
                my psyche_walk(f, (name of a), "", out)
              end repeat
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_folders
        on psyche_attachments(nid)
          set fs to character id 31
          set out to {}
          tell application "Notes"
            repeat with a in attachments of note id nid
              set end of out to (id of a as text) & fs & my psyche_clean(name of a)
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_attachments
        on psyche_append(nid, frag)
          tell application "Notes"
            set n to note id nid
            set body of n to (body of n) & frag
            return my psyche_line(n) & (character id 31) & my psyche_clean(body of n)
          end tell
        end psyche_append
        on psyche_update(nid, newName, newBody)
          tell application "Notes"
            set n to note id nid
            if newBody is not "" then set body of n to newBody
            if newName is not "" then set name of n to newName
            return my psyche_line(n) & (character id 31) & my psyche_clean(body of n)
          end tell
        end psyche_update
        """

    public init() {}

    static func summary(_ f: [String]) -> NoteSummaryRecord {
        NoteSummaryRecord(id: f[0], folder: f[1], title: f[2], modified: AppleDates.fromAppleScript(f[3]) ?? AppleDates.string(Date(timeIntervalSince1970: 0)))
    }

    public func list(folder: String?, limit: Int) async throws -> [NoteSummaryRecord] {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_list", [folder ?? "", "\(limit)"], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: 4).map(Self.summary)
    }

    public func read(id: String) async throws -> (NoteSummaryRecord, html: String, text: String) {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_read", [id], app: Self.bundleId)
        guard let f = ScriptRecords.parse(out, fields: 6).first else { throw CapabilityError(.notFound, reason: "note_not_found", "No note \(id)") }
        return (Self.summary(Array(f[0..<4])), f[4], f[5])
    }

    public func create(title: String, html: String, folder: String?) async throws -> NoteSummaryRecord {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_create", [html, folder ?? ""], app: Self.bundleId)
        guard let f = ScriptRecords.parse(out, fields: 4).first else { throw CapabilityError(.unavailable, reason: "script_error", "Notes did not return the new note") }
        return Self.summary(f)
    }

    // MARK: Wave 1

    public func search(query: String, folder: String?, since: Date?, limit: Int) async throws -> [(NoteSummaryRecord, text: String)] {
        let parts = MailSearchFilter.dateParts(since ?? Date(timeIntervalSince1970: 0))
        let matches = try await ScriptHandler.call(Self.source, handler: "psyche_search", [query, folder ?? "", parts], app: Self.bundleId)
        let ids = NotesWave1.newest(ScriptRecords.parse(matches, fields: 2), limit: limit)
        if ids.isEmpty { return [] }
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_lines", [ids, "4000"], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: 5).map { (Self.summary(Array($0[0..<4])), text: $0[4]) }
    }

    public func folders() async throws -> [NoteFolderRecord] {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_folders", [], app: Self.bundleId)
        return NoteFolderRecord.dedupe(ScriptRecords.parse(out, fields: 5).map {
            NoteFolderRecord(id: $0[0], name: $0[1], account: $0[2], parentId: $0[3].isEmpty ? nil : $0[3], noteCount: Int($0[4]) ?? 0)
        })
    }

    public func attachments(id: String) async throws -> [(id: String, name: String)] {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_attachments", [id], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: 2).map { (id: $0[0], name: $0[1]) }
    }

    func noteAndBody(_ out: String?) throws -> (NoteSummaryRecord, html: String) {
        guard let f = ScriptRecords.parse(out, fields: 5).first else { throw CapabilityError(.unavailable, reason: "script_error", "Notes did not return the note") }
        return (Self.summary(Array(f[0..<4])), html: f[4])
    }

    public func append(id: String, html: String) async throws -> (NoteSummaryRecord, html: String) {
        try noteAndBody(try await ScriptHandler.call(Self.source, handler: "psyche_append", [id, html], app: Self.bundleId))
    }

    public func update(id: String, title: String?, html: String?) async throws -> (NoteSummaryRecord, html: String) {
        try noteAndBody(try await ScriptHandler.call(Self.source, handler: "psyche_update", [id, title ?? "", html ?? ""], app: Self.bundleId))
    }
}

public final class SafariScriptingBackend: SafariBackend, @unchecked Sendable {
    static let bundleId = "com.apple.Safari"
    static let source = ScriptHandler.prelude + """
        on psyche_tabs()
          set fs to character id 31
          set out to {}
          tell application "Safari"
            set wi to 0
            repeat with w in windows
              set wi to wi + 1
              set ct to 0
              try
                set ct to index of current tab of w
              end try
              set ti to 0
              repeat with t in tabs of w
                set ti to ti + 1
                set u to ""
                try
                  set u to URL of t
                end try
                set end of out to ((wi - 1) as text) & fs & ((ti - 1) as text) & fs & my psyche_clean(name of t) & fs & my psyche_clean(u) & fs & ((wi = 1 and ti = ct) as text)
              end repeat
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_tabs
        on psyche_open(u)
          tell application "Safari"
            make new document with properties {URL:u}
          end tell
          return "ok"
        end psyche_open
        -- Wave 1 (§4.7). Fixed text; inputs are arguments. `text` is Safari's tab property, not JavaScript.
        on psyche_tab_text(wIdx, tIdx)
          set fs to character id 31
          tell application "Safari"
            set w to window ((wIdx as integer) + 1)
            if tIdx is "-1" then
              set t to current tab of w
            else
              set t to tab ((tIdx as integer) + 1) of w
            end if
            set ti to (index of t) - 1
            set isCurrent to ((index of current tab of w) = (index of t))
            set u to ""
            try
              set u to URL of t
            end try
            set tx to ""
            try
              set tx to text of t
            end try
            return (wIdx as text) & fs & (ti as text) & fs & my psyche_clean(name of t) & fs & my psyche_clean(u) & fs & ((isCurrent and wIdx is "0") as text) & fs & my psyche_clean(tx)
          end tell
        end psyche_tab_text
        on psyche_reading_list(u, ttl)
          tell application "Safari"
            if ttl is "" then
              add reading list item u
            else
              add reading list item u with title ttl
            end if
          end tell
          return "ok"
        end psyche_reading_list
        """

    public init() {}

    public func tabs() async throws -> [SafariTabRecord] {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_tabs", [], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: 5).map { f in
            SafariTabRecord(window: Int(f[0]) ?? 0, index: Int(f[1]) ?? 0, title: f[2], url: f[3], current: f[4] == "true")
        }
    }

    public func open(_ url: URL) async throws {
        _ = try await ScriptHandler.call(Self.source, handler: "psyche_open", [url.absoluteString], app: Self.bundleId)
    }

    public func tabText(window: Int?, index: Int?) async throws -> (SafariTabRecord, text: String) {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_tab_text", ["\(window ?? 0)", "\(index ?? -1)"], app: Self.bundleId)
        let f = (out ?? "").components(separatedBy: ScriptRecords.fieldSeparator)
        guard f.count == 6 else { throw CapabilityError(.notFound, reason: "no_tab", "No such Safari tab") }
        return (SafariTabRecord(window: Int(f[0]) ?? 0, index: Int(f[1]) ?? 0, title: f[2], url: f[3], current: f[4] == "true"), text: f[5])
    }

    public func addReadingList(_ url: URL, title: String?) async throws {
        _ = try await ScriptHandler.call(Self.source, handler: "psyche_reading_list", [url.absoluteString, title ?? ""], app: Self.bundleId)
    }
}

public final class ChromeScriptingBackend: ChromeBackend, @unchecked Sendable {
    static let bundleId = "com.google.Chrome"
    static let source = ScriptHandler.prelude + """
        on psyche_tabs()
          set fs to character id 31
          set out to {}
          tell application "Google Chrome"
            set wi to 0
            repeat with w in windows
              set wi to wi + 1
              set ai to 0
              try
                set ai to active tab index of w
              end try
              set ti to 0
              repeat with t in tabs of w
                set ti to ti + 1
                set end of out to ((wi - 1) as text) & fs & ((ti - 1) as text) & fs & my psyche_clean(title of t) & fs & my psyche_clean(URL of t) & fs & ((wi = 1 and ti = ai) as text)
              end repeat
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_tabs
        """

    public init() {}

    public func tabs() async throws -> [SafariTabRecord] {
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: Self.bundleId).isEmpty else { return [] }
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_tabs", [], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: 5).map { f in
            SafariTabRecord(window: Int(f[0]) ?? 0, index: Int(f[1]) ?? 0, title: f[2], url: f[3], current: f[4] == "true")
        }
    }
}

public struct WorkspaceFinderBackend: FinderBackend {
    public init() {}
    public func reveal(_ path: String) async throws {
        await MainActor.run { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
    }
}
