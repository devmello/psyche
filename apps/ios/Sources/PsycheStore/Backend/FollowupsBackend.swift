import Foundation

// Home's follow-ups and suggestions (the Mac Home's "Quiet email threads" and batch proposals). Gateway methods:
// mailFollowups.list/act, proposals.list/get/approve/dismiss/undo, approvals.answer. Nothing here sends mail on its
// own: a suggestion's calls run after the owner's one tap on Approve, and a follow-up only leaves the list.
// Mute (nudges.mute) is not offered here: it stops nudges for one person, and neither kind has a person's id.

public protocol FollowupsBackend: Sendable {
    /// Quiet email threads to follow up on now. Empty while mail follow-ups are off or no mail is connected.
    func mailFollowups() async throws -> [MailFollowup]
    /// Snoozes a thread for a week, or dismisses it until it gets new mail.
    func actOnMailFollowup(id: String, action: MailFollowupAction) async throws
    /// Suggestions waiting for a yes or no: pending, or awaiting their one approval.
    func suggestions() async throws -> [Suggestion]
    /// One suggestion as the Gateway holds it now (its calls, and its status once it ran).
    func suggestion(id: String) async throws -> Suggestion
    /// Approves a suggestion: requests its one batch approval and answers it with this phone's token, so one tap runs
    /// its calls. Refused with the Gateway's words when it can't run.
    func approveSuggestion(id: String) async throws
    func dismissSuggestion(id: String) async throws
    /// Offers the inverse of a finished, reversible suggestion. It comes back as a new suggestion waiting for its approval.
    func undoSuggestion(id: String) async throws
}

public enum MailFollowupAction: String, Sendable, Equatable { case snooze, dismiss }

public struct MailFollowup: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable, Equatable {
        /// The owner sent the last message and nobody answered.
        case noReply = "no_reply"
        /// Someone asked the owner something and the owner never replied.
        case unansweredQuestion = "unanswered_question"
    }

    public var id: String
    public var kind: Kind
    /// The other person's name or address. Third-party text, one line.
    public var who: String
    /// The thread's subject. Untrusted mail text, one line.
    public var subject: String
    /// Whole days since the last message.
    public var daysQuiet: Int

    public init(id: String, kind: Kind, who: String, subject: String, daysQuiet: Int) {
        self.id = id
        self.kind = kind
        self.who = who
        self.subject = subject
        self.daysQuiet = daysQuiet
    }
}

public struct Suggestion: Sendable, Equatable, Identifiable {
    public enum Status: String, Sendable, Equatable {
        case pending, awaitingApproval = "awaiting_approval", running, done, partial, failed, dismissed, expired
    }

    public var id: String
    public var title: String
    public var status: Status
    /// One plain line per call, in the order they run ("Mark read: Weekly digest (Acme)").
    public var callSummaries: [String]
    /// Every call is a reversible mail action, so the inverse can be offered (the Mac's rule).
    public var reversible: Bool
    /// The inverse has already been offered: Undo is no longer available.
    public var undoOffered: Bool
    /// Built from mail or other outside content: the card says so.
    public var fromOutsideContent: Bool
    /// What made it: the job that created it ("mail.digest"). Empty when the Gateway did not say.
    public var source: String

    public init(
        id: String, title: String, status: Status, callSummaries: [String], reversible: Bool = false,
        undoOffered: Bool = false, fromOutsideContent: Bool = false, source: String = ""
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.callSummaries = callSummaries
        self.reversible = reversible
        self.undoOffered = undoOffered
        self.fromOutsideContent = fromOutsideContent
        self.source = source
    }

    /// Undo is offered once a suggestion ran (done or partly done), when its calls can be reversed.
    public var canUndo: Bool { reversible && !undoOffered && (status == .done || status == .partial) }
}
