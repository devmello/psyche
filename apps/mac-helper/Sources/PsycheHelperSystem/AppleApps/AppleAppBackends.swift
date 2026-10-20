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
    func events(from: Date, to: Date, calendarIds: [String]?, limit: Int) async throws -> [CalendarEventRecord]
    func create(_ input: CalendarEventInput) async throws -> CalendarEventRecord
    func update(_ update: CalendarEventPatch) async throws -> CalendarEventRecord
}

public protocol RemindersBackend: Sendable {
    func lists() async throws -> [CalendarRecord]
    func reminders(listIds: [String]?, completed: Bool?, dueBefore: Date?, limit: Int) async throws -> [ReminderRecord]
    func create(_ input: ReminderInput) async throws -> ReminderRecord
    func update(_ patch: ReminderPatch) async throws -> ReminderRecord
}

public protocol MailBackend: Sendable {
    func search(query: String, mailbox: String?, account: String?, limit: Int) async throws -> [MailSummaryRecord]
    func read(id: String, mailbox: String?, account: String?, maxLength: Int) async throws -> (MailSummaryRecord, to: [String], cc: [String], body: String)
    /// Saves a draft, or sends when `send` (only ever called with an approval).
    func compose(_ draft: MailDraft, send: Bool) async throws
}

public protocol NotesBackend: Sendable {
    func list(folder: String?, limit: Int) async throws -> [NoteSummaryRecord]
    func read(id: String) async throws -> (NoteSummaryRecord, html: String, text: String)
    func create(title: String, html: String, folder: String?) async throws -> NoteSummaryRecord
}

public protocol SafariBackend: Sendable {
    func tabs() async throws -> [SafariTabRecord]
    func open(_ url: URL) async throws
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
}

public struct ReminderInput: Decodable, Sendable {
    public var listId: String?
    public var title: String
    public var notes: String?
    public var due: String?
    public var priority: Int?
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
            let granted = type == .event ? try await store.requestFullAccessToEvents() : try await store.requestFullAccessToReminders()
            if granted { return }
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
                    location: e.location, notes: e.notes, url: e.url?.absoluteString, recurring: e.hasRecurrenceRules)
    }

    static func record(_ r: EKReminder) -> ReminderRecord {
        ReminderRecord(id: r.calendarItemIdentifier, listId: r.calendar?.calendarIdentifier ?? "", title: r.title ?? "", notes: r.notes,
                       due: r.dueDateComponents.flatMap { Calendar.current.date(from: $0) }.map(AppleDates.string), completed: r.isCompleted,
                       priority: r.priority)
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

    public func events(from: Date, to: Date, calendarIds: [String]?, limit: Int) async throws -> [CalendarEventRecord] {
        try await ensure(.event)
        let pred = store.predicateForEvents(withStart: from, end: to, calendars: calendars(calendarIds, type: .event))
        return store.events(matching: pred).sorted { $0.startDate < $1.startDate }.prefix(limit).map(Self.record)
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

    public func create(_ input: CalendarEventInput) async throws -> CalendarEventRecord {
        try await ensure(.event)
        let e = EKEvent(eventStore: store)
        guard let cal = input.calendarId.flatMap({ store.calendar(withIdentifier: $0) }) ?? store.defaultCalendarForNewEvents else {
            throw CapabilityError(.notFound, reason: "calendar_not_found", "No such calendar")
        }
        guard cal.allowsContentModifications else { throw CapabilityError(.forbidden, reason: "calendar_read_only", "\(cal.title) is read-only") }
        e.calendar = cal
        try apply(e, title: input.title, start: input.start, end: input.end, allDay: input.allDay, location: input.location, notes: input.notes, url: input.url)
        do { try store.save(e, span: .thisEvent, commit: true) } catch { throw Self.saveError(error) }
        return Self.record(e)
    }

    public func update(_ p: CalendarEventPatch) async throws -> CalendarEventRecord {
        try await ensure(.event)
        guard let e = store.calendarItem(withIdentifier: p.id) as? EKEvent else {
            throw CapabilityError(.notFound, reason: "event_not_found", "No event \(p.id)")
        }
        try apply(e, title: p.title, start: p.start, end: p.end, allDay: p.allDay, location: p.location, notes: p.notes, url: p.url)
        do { try store.save(e, span: p.span == "future" ? .futureEvents : .thisEvent, commit: true) } catch { throw Self.saveError(error) }
        return Self.record(e)
    }

    // Reminders
    public func lists() async throws -> [CalendarRecord] {
        try await ensure(.reminder)
        return store.calendars(for: .reminder).map(Self.record)
    }

    struct Box: @unchecked Sendable { let items: [EKReminder] }

    public func reminders(listIds: [String]?, completed: Bool?, dueBefore: Date?, limit: Int) async throws -> [ReminderRecord] {
        try await ensure(.reminder)
        let cals = calendars(listIds, type: .reminder)
        let pred: NSPredicate =
            switch completed {
            case true?: store.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: cals)
            case false?: store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: dueBefore, calendars: cals)
            case nil: store.predicateForReminders(in: cals)
            }
        let box: Box = await withCheckedContinuation { c in store.fetchReminders(matching: pred) { c.resume(returning: Box(items: $0 ?? [])) } }
        return box.items.map(Self.record).filter { r in
            guard let dueBefore else { return true }
            return r.due.flatMap(AppleDates.parse).map { $0 <= dueBefore } ?? false
        }.prefix(limit).map { $0 }
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
}

// MARK: - Scripting (Mail, Notes, Safari)

/// Runs a constant AppleScript handler with string/list arguments on the main thread. Inputs are
/// arguments, never spliced into source, so app content and model text cannot become script.
enum ScriptHandler {
    static func call(_ source: String, handler: String, _ args: [Any], app bundleId: String) async throws -> String? {
        try await ensureRunning(bundleId)
        try await AutomationPermission.ensure(bundleId: bundleId, ask: true)
        nonisolated(unsafe) let args = args
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String?, Error>) in
            DispatchQueue.main.async {
                guard let lang = OSALanguage(forName: "AppleScript") else {
                    cont.resume(throwing: CapabilityError.unavailable("osa_language_missing", "AppleScript is not available"))
                    return
                }
                let script = OSAScript(source: source, language: lang)
                var error: NSDictionary?
                let result = script.executeHandler(withName: handler, arguments: args, error: &error)
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
            return (id of m as text) & fs & my psyche_clean(name of mailbox of m) & fs & my psyche_clean(name of account of mailbox of m) & fs & my psyche_clean(subject of m) & fs & my psyche_clean(sender of m) & fs & my psyche_iso(date received of m) & fs & (read status of m as text)
          end tell
        end psyche_line
        on psyche_search(q, mboxName, acctName, lim)
          set out to {}
          tell application "Mail"
            set src to my psyche_source(mboxName, acctName)
            set found to (messages of src whose subject contains q or sender contains q)
            repeat with m in found
              if (count of out) ≥ (lim as integer) then exit repeat
              set end of out to my psyche_line(m)
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_search
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
            else
              save msg
            end if
          end tell
          return mode
        end psyche_compose
        """

    public init() {}

    static func summary(_ f: [String]) -> MailSummaryRecord {
        MailSummaryRecord(id: f[0], mailbox: f[1], account: f[2], subject: f[3], from: f[4],
                          date: AppleDates.fromAppleScript(f[5]) ?? AppleDates.string(Date(timeIntervalSince1970: 0)), read: f[6] == "true")
    }

    public func search(query: String, mailbox: String?, account: String?, limit: Int) async throws -> [MailSummaryRecord] {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_search", [query, mailbox ?? "", account ?? "", "\(limit)"], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: 7).map(Self.summary)
    }

    public func read(id: String, mailbox: String?, account: String?, maxLength: Int) async throws -> (MailSummaryRecord, to: [String], cc: [String], body: String) {
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_read", [id, mailbox ?? "", account ?? "", "\(maxLength)"], app: Self.bundleId)
        guard let f = ScriptRecords.parse(out, fields: 10).first else { throw CapabilityError(.notFound, reason: "message_not_found", "No message \(id)") }
        let split: (String) -> [String] = { $0.isEmpty ? [] : $0.components(separatedBy: "\u{1D}") }
        return (Self.summary(Array(f[0..<7])), split(f[7]), split(f[8]), f[9])
    }

    public func compose(_ draft: MailDraft, send: Bool) async throws {
        _ = try await ScriptHandler.call(Self.source, handler: "psyche_compose",
                                         [draft.to, draft.cc ?? [], draft.subject, draft.body, send ? "send" : "draft"], app: Self.bundleId)
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
}

public struct WorkspaceFinderBackend: FinderBackend {
    public init() {}
    public func reveal(_ path: String) async throws {
        await MainActor.run { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
    }
}
