import Foundation

// What Psyche learned from the owner, the claims it is not sure of, and recent memory changes (memory.lessons.*,
// memory.claims.*, memory.review.*, memory.remember). Owner: the Memory session.

/// A lesson Psyche took from the owner's feedback (memory.lessons.list): the line in Psyche's words, the value
/// it writes, and the value it replaced.
public struct LessonItem: Sendable, Equatable, Hashable, Identifiable {
    /// The Gateway's own value, `"style"`, `"fact"`, …: kept as text so an unknown kind still shows.
    public var id: String
    public var statement: String
    public var value: String
    /// The line or value the lesson replaced. Restored when the lesson is forgotten.
    public var previous: String?
    /// 0–1, shown to the owner in words (Confident, Fairly sure, Unsure).
    public var confidence: Double
    public var confirmed: Bool

    public init(id: String, statement: String, value: String, previous: String? = nil, confidence: Double, confirmed: Bool) {
        self.id = id
        self.statement = statement
        self.value = value
        self.previous = previous
        self.confidence = confidence
        self.confirmed = confirmed
    }
}

/// A memory claim Psyche is not sure of, waiting for the owner (memory.claims.list).
public struct ClaimItem: Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var text: String
    public var confidence: Double

    public init(id: String, text: String, confidence: Double) {
        self.id = id
        self.text = text
        self.confidence = confidence
    }
}

/// A fact Psyche accepted on its own, undoable for a week (memory.review.list, `auto_accepted`).
public struct RecentChange: Sendable, Equatable, Hashable, Identifiable {
    public enum Change: String, Sendable, Equatable, Hashable { case new, changed, conflict }

    /// The fact id, what memory.review.undo takes.
    public var id: String
    /// The fact as a sentence, e.g. "Ava's birthday is May 3". Untrusted text from the source.
    public var sentence: String
    public var entityName: String
    public var change: Change
    /// The value it superseded or disagrees with.
    public var previousValue: String?

    public init(id: String, sentence: String, entityName: String, change: Change, previousValue: String? = nil) {
        self.id = id
        self.sentence = sentence
        self.entityName = entityName
        self.change = change
        self.previousValue = previousValue
    }
}
