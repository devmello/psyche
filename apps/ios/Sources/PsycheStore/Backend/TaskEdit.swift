import Foundation

// The edit sheet's state for a specialist job's limits, and the rules Save follows. Pure, so the tests need no
// view. The fields are text, read with the phone's own number format (a German phone types "1,5"). Nothing here
// is user-visible text, so it has no string catalog; the sheet in PsycheFeatures owns the words.

/// The edit sheet's state. A field the owner never touched keeps its text and is never sent, even when the
/// Gateway sent no value for it: a blank untouched field is fine, a blank field the owner cleared is not.
public struct TaskEditDraft: Sendable, Equatable {
    public let original: TaskLimits
    public var tokensText: String
    public var costText: String
    public var minutesText: String
    /// The new deadline, or nil for none. A job with a deadline keeps one: the sheet never offers to clear it.
    public var deadline: Date?
    /// The moment a deadline must be later than.
    public let now: Date

    private let initialTokens: String
    private let initialCost: String
    private let initialMinutes: String

    public init(limits: TaskLimits, now: Date = .now) {
        original = limits
        self.now = now
        initialTokens = limits.tokens.map { Self.integerText($0) } ?? ""
        initialCost = limits.costUsd.map { Self.costText($0) } ?? ""
        initialMinutes = limits.minutes.map { Self.integerText($0) } ?? ""
        tokensText = initialTokens
        costText = initialCost
        minutesText = initialMinutes
        deadline = limits.deadline
    }

    // MARK: Parsing

    /// Whole tokens, at least 1, from the field's text.
    public var tokensValue: Int? { Self.whole(tokensText, atLeast: 1) }
    /// Minutes, a whole number at least 1.
    public var minutesValue: Int? { Self.whole(minutesText, atLeast: 1) }
    /// A cost in dollars, zero or more.
    public var costValue: Double? {
        guard let value = Self.number(costText), value >= 0 else { return nil }
        return value
    }

    private var tokensEdited: Bool { tokensText.clean != initialTokens.clean }
    private var costEdited: Bool { costText.clean != initialCost.clean }
    private var minutesEdited: Bool { minutesText.clean != initialMinutes.clean }

    /// A field is ok when it parses, or when the owner left it untouched and blank.
    private var tokensOK: Bool { tokensValue != nil || (!tokensEdited && tokensText.clean.isEmpty) }
    private var costOK: Bool { costValue != nil || (!costEdited && costText.clean.isEmpty) }
    private var minutesOK: Bool { minutesValue != nil || (!minutesEdited && minutesText.clean.isEmpty) }

    /// The deadline is in the future, or it is the job's own deadline left as it was.
    public var deadlineOK: Bool {
        guard let deadline else { return true }
        return deadline == original.deadline || deadline > now
    }

    /// Show a field's error only once the owner has edited it (the field is then blank or unparsable).
    public var tokensInvalid: Bool { tokensEdited && tokensValue == nil }
    public var costInvalid: Bool { costEdited && costValue == nil }
    public var minutesInvalid: Bool { minutesEdited && minutesValue == nil }
    public var deadlineInvalid: Bool { !deadlineOK }

    /// What changed against the limits the sheet opened with. Nil when nothing did.
    public var changes: TaskChanges? {
        var out = TaskChanges()
        if tokensEdited, let tokens = tokensValue, tokens != original.tokens { out.tokens = tokens }
        if costEdited, let cost = costValue, cost != original.costUsd { out.costUsd = cost }
        if minutesEdited, let minutes = minutesValue, minutes != original.minutes { out.minutes = minutes }
        if let deadline, deadline != original.deadline { out.deadline = deadline }
        return out.isEmpty ? nil : out
    }

    /// Save is allowed once something changed and every field is valid.
    public var canSave: Bool {
        changes != nil && tokensOK && costOK && minutesOK && deadlineOK
    }

    // MARK: Number format

    private static func number(_ text: String) -> Double? {
        let formatter = NumberFormatter()
        formatter.locale = .current
        formatter.numberStyle = .decimal
        return formatter.number(from: text.clean)?.doubleValue
    }

    private static func whole(_ text: String, atLeast minimum: Int) -> Int? {
        guard let value = number(text), value == value.rounded(), value >= Double(minimum), value <= Double(Int.max) else { return nil }
        return Int(value)
    }

    private static func integerText(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = .current
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    private static func costText(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = .current
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}

private extension String {
    var clean: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
