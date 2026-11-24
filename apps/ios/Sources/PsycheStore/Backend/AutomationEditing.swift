import Foundation

// Creating, editing and deleting automations from the phone. The rules mirror the Mac's automation form
// (packages/ui/src/screens/scheduled/schedule-form.ts), so both write the same schedule strings. The Gateway reads
// the schedule string: a 5-field cron in the automation's zone (`minute hour day month weekday`), an ISO-8601
// duration for an interval (`PT6H`), or an ISO-8601 instant with an offset for a one-time reminder.

/// The presets the form offers. `custom` keeps a schedule the picker cannot express, as the Gateway stored it.
public enum AutomationPreset: String, Sendable, Equatable, CaseIterable, Identifiable {
    case once, daily, weekdays, weekly, interval, custom
    public var id: String { rawValue }
}

/// Why a schedule cannot be saved.
public enum AutomationScheduleProblem: String, Sendable, Equatable, Error {
    /// A one-time time that has already gone.
    case past
    /// A weekly schedule with no day chosen.
    case noDays
    /// An interval outside 1 to 168 hours.
    case hours
    /// A one-time schedule became repeating, or the other way round. The Gateway keeps an automation's kind.
    case switchKind
    /// A custom schedule with no text.
    case emptyCustom
}

/// What the owner picked for when the automation runs.
public struct AutomationSchedule: Sendable, Equatable {
    public var preset: AutomationPreset
    /// The one-time instant (`once`). Seconds are dropped when the schedule is written.
    public var onceAt: Date
    /// Minutes after midnight in the zone the schedule is written in (`daily`, `weekdays`, `weekly`).
    public var minuteOfDay: Int
    /// Cron weekdays, 0 = Sunday … 6 = Saturday (`weekly`).
    public var weekdays: Set<Int>
    /// Hours between runs (`interval`), 1 to 168.
    public var intervalHours: Int
    /// The schedule text as stored (`custom`).
    public var customText: String

    public init(
        preset: AutomationPreset = .daily, onceAt: Date = AutomationSchedule.nextWholeHour(now: Date(), zone: .current),
        minuteOfDay: Int = 9 * 60,
        weekdays: Set<Int> = [1], intervalHours: Int = 6, customText: String = ""
    ) {
        self.preset = preset
        self.onceAt = onceAt
        self.minuteOfDay = minuteOfDay
        self.weekdays = weekdays
        self.intervalHours = intervalHours
        self.customText = customText
    }

    /// The next whole hour after `now`, in `zone`: where a one-time schedule starts when the owner switches to Once.
    public static func nextWholeHour(now: Date, zone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let thisHour = calendar.dateInterval(of: .hour, for: now)?.start ?? now
        return calendar.date(byAdding: .hour, value: 1, to: thisHour) ?? now.addingTimeInterval(3600)
    }

    /// The presets an automation's Repeats picker offers. A new one gets every preset; one that repeats never gets
    /// Once, and a one-time automation gets only Once, since the Gateway keeps an automation's kind. `current` stays
    /// offered when it is a custom schedule the picker cannot write, so it can still be kept as it is.
    public static func choices(editingKind: String?, current: AutomationPreset) -> [AutomationPreset] {
        var base: [AutomationPreset]
        switch editingKind {
        case nil: base = [.once, .daily, .weekdays, .weekly, .interval]
        case "reminder": base = [.once]
        default: base = [.daily, .weekdays, .weekly, .interval]
        }
        if current == .custom { base.append(.custom) }
        return base
    }

    /// Daily at 09:00, as the Mac's form starts. A one-time schedule starts tomorrow at 09:00 in `zone`.
    public static func defaults(now: Date, zone: TimeZone) -> AutomationSchedule {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now.addingTimeInterval(86_400)
        let nine = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        return AutomationSchedule(onceAt: nine)
    }

    /// The Gateway's kind and schedule string for this choice, written in `zone` and checked against `now`.
    /// `editingKind` is the kind of the automation being edited, nil for a new one.
    public func wire(zone: TimeZone, now: Date, editingKind: String?) -> Result<AutomationWireSchedule, AutomationScheduleProblem> {
        if preset == .custom {
            let text = customText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return .failure(.emptyCustom) }
            return .success(AutomationWireSchedule(kind: editingKind ?? "cron", schedule: text))
        }
        if let editingKind, (editingKind == "reminder") != (preset == .once) {
            return .failure(.switchKind)
        }
        switch preset {
        case .once:
            let minute = Self.minuteFloor(onceAt)
            guard minute > now else { return .failure(.past) }
            return .success(AutomationWireSchedule(kind: "reminder", schedule: Self.isoWithOffset(minute, zone: zone)))
        case .interval:
            guard (1...168).contains(intervalHours) else { return .failure(.hours) }
            return .success(AutomationWireSchedule(kind: "interval", schedule: "PT\(intervalHours)H"))
        case .daily:
            return .success(cron(days: "*"))
        case .weekdays:
            return .success(cron(days: "1-5"))
        case .weekly:
            guard !weekdays.isEmpty else { return .failure(.noDays) }
            return .success(cron(days: weekdays.filter { (0...6).contains($0) }.sorted().map(String.init).joined(separator: ",")))
        case .custom:
            return .failure(.emptyCustom)
        }
    }

    private func cron(days: String) -> AutomationWireSchedule {
        AutomationWireSchedule(kind: "cron", schedule: "\(minuteOfDay % 60) \(minuteOfDay / 60) * * \(days)")
    }

    /// The choice an existing automation's kind and schedule string stand for. Anything the picker cannot read
    /// becomes `custom`, kept as stored.
    public static func from(kind: String, schedule: String, zone: TimeZone) -> AutomationSchedule {
        let text = schedule.trimmingCharacters(in: .whitespacesAndNewlines)
        let custom = AutomationSchedule(preset: .custom, customText: text)
        if kind == "reminder" {
            guard let instant = parseInstant(text) else { return custom }
            return AutomationSchedule(preset: .once, onceAt: instant)
        }
        if text.hasPrefix("PT"), text.hasSuffix("H"), let hours = Int(text.dropFirst(2).dropLast()), (1...168).contains(hours) {
            return AutomationSchedule(preset: .interval, intervalHours: hours)
        }
        let parts = text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 5, parts[2] == "*", parts[3] == "*",
              let minute = Int(parts[0]), let hour = Int(parts[1]), (0..<60).contains(minute), (0..<24).contains(hour)
        else { return custom }
        let minuteOfDay = hour * 60 + minute
        switch parts[4] {
        case "*":
            return AutomationSchedule(preset: .daily, minuteOfDay: minuteOfDay)
        case "1-5":
            return AutomationSchedule(preset: .weekdays, minuteOfDay: minuteOfDay)
        default:
            let days = parts[4].split(separator: ",").compactMap { Int($0) }
            guard !days.isEmpty, days.allSatisfy({ (0...6).contains($0) }) else { return custom }
            return AutomationSchedule(preset: .weekly, minuteOfDay: minuteOfDay, weekdays: Set(days))
        }
    }

    /// The instant with seconds dropped: the form works to the minute.
    static func minuteFloor(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.down) * 60)
    }

    /// `2026-11-20T09:00:00-08:00`, the reminder form the Gateway reads.
    static func isoWithOffset(_ date: Date, zone: TimeZone) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = zone
        return formatter.string(from: date)
    }

    static func parseInstant(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: text) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }
}

/// The schedule as the Gateway takes it.
public struct AutomationWireSchedule: Sendable, Equatable {
    public var kind: String
    public var schedule: String
    public init(kind: String, schedule: String) {
        self.kind = kind
        self.schedule = schedule
    }
}

/// An automation as `automations.list` holds it, with the fields the editor needs.
public struct AutomationDetail: Sendable, Equatable, Identifiable {
    public var id: String
    /// "cron", "interval", "reminder", or a trigger kind the phone edits only on the Mac.
    public var kind: String
    public var title: String
    public var prompt: String
    public var schedule: String
    public var timezone: String
    public var enabled: Bool

    public init(id: String, kind: String, title: String, prompt: String, schedule: String, timezone: String, enabled: Bool) {
        self.id = id
        self.kind = kind
        self.title = title
        self.prompt = prompt
        self.schedule = schedule
        self.timezone = timezone
        self.enabled = enabled
    }

    /// Kinds the phone's form can write: the three the schedule presets map to.
    public var isFormKind: Bool { ["cron", "interval", "reminder"].contains(kind) }

    /// The zone the schedule is written in; the device's zone when the stored name is unknown.
    public var zone: TimeZone { TimeZone(identifier: timezone) ?? .current }
}

/// Why the prompt is refused: the words the form shows under it are different for each.
public enum AutomationPromptProblem: String, Sendable, Equatable {
    case empty
    case tooLong
}

/// What the form shows as wrong. Save stays off while any of these is set.
public struct AutomationDraftProblems: Sendable, Equatable, Error {
    public var prompt = false
    public var title = false
    public var schedule: AutomationScheduleProblem?
    public init(prompt: Bool = false, title: Bool = false, schedule: AutomationScheduleProblem? = nil) {
        self.prompt = prompt
        self.title = title
        self.schedule = schedule
    }
    public var isEmpty: Bool { !prompt && !title && schedule == nil }
}

/// `automations.create`'s params.
public struct AutomationCreate: Sendable, Equatable {
    public var kind: String
    public var title: String
    public var schedule: String
    public var prompt: String
    public var timezone: String
    public var enabled: Bool
    public init(kind: String, title: String, schedule: String, prompt: String, timezone: String, enabled: Bool) {
        self.kind = kind
        self.title = title
        self.schedule = schedule
        self.prompt = prompt
        self.timezone = timezone
        self.enabled = enabled
    }
}

/// Only the fields that changed. `nil` means "leave it as it is" and is not sent.
public struct AutomationChanges: Sendable, Equatable {
    public var title: String?
    public var prompt: String?
    public var schedule: String?
    public var enabled: Bool?
    public init(title: String? = nil, prompt: String? = nil, schedule: String? = nil, enabled: Bool? = nil) {
        self.title = title
        self.prompt = prompt
        self.schedule = schedule
        self.enabled = enabled
    }
    public var isEmpty: Bool { title == nil && prompt == nil && schedule == nil && enabled == nil }
}

/// What the editor holds before it is saved. Title and prompt are trimmed on the way out, as the Mac trims them.
public struct AutomationDraft: Sendable, Equatable {
    public static let maxTitle = 200
    public static let maxPrompt = 20_000
    public static let maxTitleFromPrompt = 80

    public var title: String
    public var prompt: String
    public var schedule: AutomationSchedule
    public var enabled: Bool

    public init(title: String = "", prompt: String = "", schedule: AutomationSchedule, enabled: Bool = true) {
        self.title = title
        self.prompt = prompt
        self.schedule = schedule
        self.enabled = enabled
    }

    /// The draft an existing automation starts from.
    public init(_ detail: AutomationDetail) {
        self.init(
            title: detail.title, prompt: detail.prompt,
            schedule: AutomationSchedule.from(kind: detail.kind, schedule: detail.schedule, zone: detail.zone),
            enabled: detail.enabled)
    }

    public var trimmedPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The title that is saved: the owner's, or the prompt's first line when it is blank.
    public var effectiveTitle: String {
        if !trimmedTitle.isEmpty { return String(trimmedTitle.prefix(Self.maxTitle)) }
        let firstLine = trimmedPrompt.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let line = String(firstLine.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxTitleFromPrompt))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return line.isEmpty ? "Automation" : line
    }

    /// Why the prompt cannot be saved, if it cannot: empty, or over the limit. Length counts the trimmed text.
    public var promptProblem: AutomationPromptProblem? {
        if trimmedPrompt.isEmpty { return .empty }
        if trimmedPrompt.utf16.count > Self.maxPrompt { return .tooLong }
        return nil
    }

    /// What is wrong with the draft. Empty when it can be saved.
    public func problems(zone: TimeZone, now: Date, editingKind: String?) -> AutomationDraftProblems {
        var found = AutomationDraftProblems(
            prompt: trimmedPrompt.isEmpty || trimmedPrompt.utf16.count > Self.maxPrompt,
            title: trimmedTitle.utf16.count > Self.maxTitle)
        if case .failure(let problem) = schedule.wire(zone: zone, now: now, editingKind: editingKind) {
            found.schedule = problem
        }
        return found
    }

    /// The `automations.create` params for a new automation, or the problems.
    public func create(zone: TimeZone, now: Date) -> Result<AutomationCreate, AutomationDraftProblems> {
        let problems = problems(zone: zone, now: now, editingKind: nil)
        guard problems.isEmpty, case .success(let wire) = schedule.wire(zone: zone, now: now, editingKind: nil) else {
            return .failure(problems)
        }
        return .success(AutomationCreate(
            kind: wire.kind, title: effectiveTitle, schedule: wire.schedule, prompt: trimmedPrompt,
            timezone: zone.identifier, enabled: enabled))
    }

    /// The changed fields against the automation as it is now, or the problems. Nothing changed gives empty changes.
    public func changes(from detail: AutomationDetail, now: Date) -> Result<AutomationChanges, AutomationDraftProblems> {
        let problems = problems(zone: detail.zone, now: now, editingKind: detail.kind)
        guard problems.isEmpty, case .success(let wire) = schedule.wire(zone: detail.zone, now: now, editingKind: detail.kind) else {
            return .failure(problems)
        }
        var changes = AutomationChanges()
        if effectiveTitle != detail.title { changes.title = effectiveTitle }
        if trimmedPrompt != detail.prompt.trimmingCharacters(in: .whitespacesAndNewlines) { changes.prompt = trimmedPrompt }
        if wire.schedule != detail.schedule.trimmingCharacters(in: .whitespacesAndNewlines) { changes.schedule = wire.schedule }
        if enabled != detail.enabled { changes.enabled = enabled }
        return .success(changes)
    }
}
