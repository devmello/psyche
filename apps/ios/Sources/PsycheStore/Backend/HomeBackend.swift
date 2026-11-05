import Foundation

// Home (docs/design/ios-app-2026.md §4.1, §4.3): the landing tab, approvals, questions, nudges and the
// inbox. Owner: the Home session (I5). Gateway methods: approvals.list/get/answer, questions.list/
// answer, notifications.list/markRead, nudges.list/act, daily.*, memory.catchup.*.

public protocol HomeBackend: Sendable {
    func home() async throws -> HomeSnapshot
    /// Answer an approval. The UI has already asked for Face ID when `presenceNote` is set; the real
    /// backend attaches the Secure Enclave presence assertion (companion §5).
    func answerApproval(id: String, decision: ApprovalDecision) async throws
    /// Answer a question, from Home or from the thread that asked it (same id on both surfaces).
    func answerQuestion(id: String, answer: QuestionAnswer) async throws
    func actOnNudge(id: String, action: NudgeAction) async throws
    func inbox() async throws -> [InboxItem]
    func markRead(ids: [String]) async throws
}

public enum ApprovalDecision: String, Sendable, Equatable { case allow, deny }

public struct QuestionAnswer: Sendable, Equatable {
    public var optionID: String?
    public var text: String?
    public init(optionID: String? = nil, text: String? = nil) {
        self.optionID = optionID
        self.text = text
    }
}

public enum NudgeAction: String, Sendable, Equatable { case startMessage, snooze, mute }

public struct InboxItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var body: String
    /// "Approval", "Question", "Done", "Brief".
    public var kindLabel: String
    public var time: String
    public var needsYou: Bool
    public var read: Bool
    /// A desktop route (`/chat/<id>`, `/library/…`) the phone maps with `Route(appPath:)`.
    public var route: String?
    /// The `NeedsYouItem` this entry is about, so a tap can open the approval or question sheet.
    public var needsYouID: String?
    /// Older than today: the Inbox puts it under "Earlier".
    public var earlier: Bool

    public init(
        id: String, title: String, body: String, kindLabel: String, time: String,
        needsYou: Bool = false, read: Bool = false, route: String? = nil, needsYouID: String? = nil,
        earlier: Bool = false
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.kindLabel = kindLabel
        self.time = time
        self.needsYou = needsYou
        self.read = read
        self.route = route
        self.needsYouID = needsYouID
        self.earlier = earlier
    }
}

public struct HomeSnapshot: Sendable, Equatable {
    public var needsYou: [NeedsYouItem]
    public var running: [RunningTask]
    public var today: [BriefItem]
    public var keepInTouch: [Nudge]
    public var updatedAt: Date

    public init(
        needsYou: [NeedsYouItem], running: [RunningTask], today: [BriefItem],
        keepInTouch: [Nudge], updatedAt: Date
    ) {
        self.needsYou = needsYou
        self.running = running
        self.today = today
        self.keepInTouch = keepInTouch
        self.updatedAt = updatedAt
    }
}

public struct NeedsYouItem: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable { case approval, question, task }

    public var id: String
    public var kind: Kind
    public var title: String
    /// "Bills automation", "Q3 review": where it came from.
    public var source: String
    /// Mono time, "9:12".
    public var time: String
    public var approval: ApprovalDetail?
    /// The options and prompt of a question, so Home can answer it without opening the thread.
    public var question: QuestionDetail?
    /// The chat thread this came from, for questions and tasks.
    public var threadID: String?
    /// The running task this waits on, so its Live Activity can say "Needs approval".
    public var taskID: String?

    public init(
        id: String, kind: Kind, title: String, source: String, time: String,
        approval: ApprovalDetail? = nil, threadID: String? = nil, question: QuestionDetail? = nil,
        taskID: String? = nil
    ) {
        self.taskID = taskID
        self.id = id
        self.kind = kind
        self.title = title
        self.source = source
        self.time = time
        self.approval = approval
        self.threadID = threadID
        self.question = question
    }
}

/// A question Psyche asked: a prompt, a few options, and optionally a free-text answer.
public struct QuestionDetail: Sendable, Equatable {
    public struct Option: Sendable, Equatable, Identifiable {
        public var id: String
        public var label: String
        /// A quiet line under the label ("Sent Oct 30 · 14 slides").
        public var detail: String?
        public init(id: String, label: String, detail: String? = nil) {
            self.id = id
            self.label = label
            self.detail = detail
        }
    }

    public var prompt: String
    public var options: [Option]
    public var allowsFreeText: Bool

    public init(prompt: String, options: [Option], allowsFreeText: Bool = true) {
        self.prompt = prompt
        self.options = options
        self.allowsFreeText = allowsFreeText
    }
}

/// Everything an approval shows, never truncated (security §3.7).
public struct ApprovalDetail: Sendable, Equatable {
    public struct Field: Sendable, Equatable, Identifiable {
        public var key: String
        public var value: String
        public var id: String { key }
        public init(key: String, value: String) {
            self.key = key
            self.value = value
        }
    }

    public var kindLabel: String
    public var title: String
    public var summary: String
    public var fields: [Field]
    public var evidence: [String]
    public var alsoSentTo: String
    /// "Payments need Face ID on this phone." nil when no presence check applies.
    public var presenceNote: String?
    public var allowLabel: String

    public init(
        kindLabel: String, title: String, summary: String, fields: [Field], evidence: [String],
        alsoSentTo: String, presenceNote: String?, allowLabel: String
    ) {
        self.kindLabel = kindLabel
        self.title = title
        self.summary = summary
        self.fields = fields
        self.evidence = evidence
        self.alsoSentTo = alsoSentTo
        self.presenceNote = presenceNote
        self.allowLabel = allowLabel
    }
}

public struct RunningTask: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var step: Int
    public var stepCount: Int
    public var detail: String
    public var elapsed: String
    /// When the task started, for a Live Activity's timer. nil when the Gateway did not say.
    public var startedAt: Date?

    public var fraction: Double { stepCount > 0 ? Double(step) / Double(stepCount) : 0 }

    public init(
        id: String, title: String, step: Int, stepCount: Int, detail: String, elapsed: String, startedAt: Date? = nil
    ) {
        self.startedAt = startedAt
        self.id = id
        self.title = title
        self.step = step
        self.stepCount = stepCount
        self.detail = detail
        self.elapsed = elapsed
    }
}

public struct BriefItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var text: String
    /// "Because" or "Sources".
    public var evidenceLabel: String
    public var evidence: [String]

    public init(id: String, text: String, evidenceLabel: String, evidence: [String]) {
        self.id = id
        self.text = text
        self.evidenceLabel = evidenceLabel
        self.evidence = evidence
    }
}

public struct Nudge: Sendable, Equatable, Identifiable {
    public var id: String
    public var initials: String
    public var text: String
    /// What "Start a message" puts in the composer. nil: the UI makes one from `text`.
    public var draft: String?

    public init(id: String, initials: String, text: String, draft: String? = nil) {
        self.id = id
        self.initials = initials
        self.text = text
        self.draft = draft
    }
}

extension HomeSnapshot {
    public static let skeleton = HomeSnapshot(
        needsYou: (1...2).map {
            NeedsYouItem(id: "sk\($0)", kind: .approval, title: "Placeholder title for a row", source: "Source", time: "0:00")
        },
        running: [RunningTask(id: "skr", title: "Placeholder task title", step: 1, stepCount: 4, detail: "detail", elapsed: "1 min")],
        today: (1...2).map { BriefItem(id: "skb\($0)", text: "Placeholder text for a line of the brief that wraps onto a second line.", evidenceLabel: "Because", evidence: ["source"]) },
        keepInTouch: [], updatedAt: .distantPast)
}
