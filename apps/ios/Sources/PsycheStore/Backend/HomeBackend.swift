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
    /// One page of the inbox, newest first. `cursor` is nil for the first page; `nextCursor` is nil on the last.
    func inboxPage(cursor: String?) async throws -> InboxPage
    func markRead(ids: [String]) async throws
    /// Taps one of a Gateway notice's own buttons ("Keep it"), the same `notifications.resolve` call the web inbox makes.
    /// Approval buttons are not here: they answer through `answerApproval`.
    func resolveNotice(id: String, actionID: String) async throws
    /// Marks a Today follow-up done, snoozes it or dismisses it (`daily.followups.update`). A snooze without `until`
    /// comes back tomorrow morning, as the Gateway's default does. The row leaves Today once the Gateway answers.
    func actOnFollowup(id: String, action: FollowupAction, until: Date?) async throws
}

public enum FollowupAction: String, Sendable, Equatable { case done, snooze, dismiss }

public enum ApprovalDecision: String, Sendable, Equatable { case allow, deny }

/// The answer to every part of a question request: one value per part, keyed by the part's header. The wire
/// shape of `questions.answer` (`QuestionAnswers`): a text for a single choice or a typed answer, an array for a
/// multi-select.
public struct QuestionAnswer: Sendable, Equatable {
    public enum Value: Sendable, Equatable {
        case text(String)
        case choices([String])
    }

    public var values: [String: Value]

    public init(values: [String: Value] = [:]) {
        self.values = values
    }

    /// A single-part answer from a surface that doesn't know the part's header (the chat card's option tap). It is
    /// keyed by the empty string, and the Gateway backend files it under the request's only part.
    public init(singleText text: String) {
        self.values = [Self.onlyPartKey: .text(text)]
    }

    public static let onlyPartKey = ""
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
    /// The message ids of a Gateway notice, so the app can word it in its own language. nil: show `title` and `body`.
    public var message: InboxNoticeKeys?
    /// The notice's own buttons ("Keep it"). Empty for approvals and questions, which answer through their own calls.
    public var actions: [InboxAction]

    public init(
        id: String, title: String, body: String, kindLabel: String, time: String,
        needsYou: Bool = false, read: Bool = false, route: String? = nil, needsYouID: String? = nil,
        earlier: Bool = false, message: InboxNoticeKeys? = nil, actions: [InboxAction] = []
    ) {
        self.message = message
        self.actions = actions
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

/// One page of the inbox. `nextCursor` is nil when this is the last page.
public struct InboxPage: Sendable, Equatable {
    public var items: [InboxItem]
    public var nextCursor: String?

    public init(items: [InboxItem], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

/// A Gateway notice's message ids and values (`NoticeMessage` on the wire). The app words it with its own
/// String Catalog; an id it does not know falls back to the Gateway's English text.
public struct InboxNoticeKeys: Sendable, Equatable {
    public var titleKey: String
    public var bodyKey: String
    public var params: [String: String]

    public init(titleKey: String, bodyKey: String, params: [String: String] = [:]) {
        self.titleKey = titleKey
        self.bodyKey = bodyKey
        self.params = params
    }
}

/// A button on a Gateway notice ("Keep it"). A tap resolves the notice with `id`.
public struct InboxAction: Sendable, Equatable, Identifiable {
    public var id: String
    /// The Gateway's English label, for a client that does not know `labelKey`.
    public var label: String
    public var labelKey: String?
    public var destructive: Bool

    public init(id: String, label: String, labelKey: String? = nil, destructive: Bool = false) {
        self.id = id
        self.label = label
        self.labelKey = labelKey
        self.destructive = destructive
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

/// A question Psyche asked: one or more parts (1-4, as `ask_user` sends them), each with a prompt and options.
/// Every part is answered before the answer can be sent.
public struct QuestionDetail: Sendable, Equatable {
    public struct Option: Sendable, Equatable, Identifiable {
        public var id: String
        public var label: String
        /// A quiet line under the label ("Sent Oct 30 · 14 slides").
        public var detail: String?
        /// The text the answer carries for this option (the label the agent matches). Defaults to `label`.
        public var value: String
        public init(id: String, label: String, detail: String? = nil, value: String? = nil) {
            self.id = id
            self.label = label
            self.detail = detail
            self.value = value ?? label
        }
    }

    /// One question of the request. `header` keys its answer on the wire.
    public struct Part: Sendable, Equatable, Identifiable {
        public var header: String
        public var prompt: String
        public var options: [Option]
        /// A multi-select part takes several options (an array on the wire); otherwise one.
        public var multiSelect: Bool
        /// The "Other" row: a typed answer of the owner's own words.
        public var allowsFreeText: Bool
        public var id: String { header }
        public init(
            header: String, prompt: String, options: [Option], multiSelect: Bool = false, allowsFreeText: Bool = true
        ) {
            self.header = header
            self.prompt = prompt
            self.options = options
            self.multiSelect = multiSelect
            self.allowsFreeText = allowsFreeText
        }
    }

    public var parts: [Part]

    public init(parts: [Part]) {
        self.parts = parts
    }

    /// A single-part question, as the fixtures and older callers build it.
    public init(prompt: String, options: [Option], allowsFreeText: Bool = true) {
        self.parts = [Part(header: "Answer", prompt: prompt, options: options, allowsFreeText: allowsFreeText)]
    }

    /// The first part's prompt and options. Use `parts` for a request with several.
    public var prompt: String { parts.first?.prompt ?? "" }
    public var options: [Option] { parts.first?.options ?? [] }
    public var allowsFreeText: Bool { parts.first?.allowsFreeText ?? false }
}

/// Everything an approval shows, never truncated (security §3.7).
public struct ApprovalDetail: Sendable, Equatable {
    public struct Field: Sendable, Equatable, Identifiable {
        public var key: String
        public var value: String
        /// How far down the nested details this row sits (0 for a top-level field).
        public var depth: Int
        /// Code or a command: shown in monospace.
        public var monospaced: Bool
        /// The row's position at each level of the details ("0/2/1"), so no two rows of a card share an id.
        public var path: String
        public var id: String { path }
        public init(key: String, value: String, depth: Int = 0, monospaced: Bool = false, path: String? = nil) {
            self.key = key
            self.value = value
            self.depth = depth
            self.monospaced = monospaced
            self.path = path ?? key
        }
    }

    public var kindLabel: String
    public var title: String
    public var summary: String
    public var fields: [Field]
    public var evidence: [String]
    public var alsoSentTo: String
    /// "Payments need Face ID on this phone." nil when no presence check applies. Only a payment the phone itself
    /// answers sets it: it is what makes Allow ask for Face ID.
    public var presenceNote: String?
    public var allowLabel: String
    /// A device-only card (a security change, a destructive action), one whose details are long or span lines, or
    /// one for another computer: a plain tap on the phone, but read in the app first, so no Approve button on the
    /// lock screen or the Dynamic Island.
    public var reviewInApp: Bool
    /// The phone can't answer Allow on this card (a payment it has no presence key for, details too long to show in
    /// full, a card not sent to this phone): Allow is off and the card says "This one needs your Mac." Never a
    /// reason to ask for Face ID.
    public var needsMac: Bool
    /// Whether Deny works from this phone. False when the phone holds no answer for the card at all (a payment, a card
    /// its caller kept on the Mac): Deny is off too, under the same note.
    public var canDeny: Bool
    /// The paired computer the action is for ("lab-box"), from the approval's `machine`. nil means this Mac.
    public var machineName: String?

    public init(
        kindLabel: String, title: String, summary: String, fields: [Field], evidence: [String],
        alsoSentTo: String, presenceNote: String?, allowLabel: String, reviewInApp: Bool = false,
        needsMac: Bool = false, canDeny: Bool = true, machineName: String? = nil
    ) {
        self.machineName = machineName
        self.kindLabel = kindLabel
        self.title = title
        self.summary = summary
        self.fields = fields
        self.evidence = evidence
        self.alsoSentTo = alsoSentTo
        self.presenceNote = presenceNote
        self.allowLabel = allowLabel
        self.reviewInApp = reviewInApp
        self.needsMac = needsMac
        self.canDeny = canDeny
    }

    /// Whether Allow asks for Face ID first: a card with a presence note (a payment) that the phone answers itself.
    /// A needs-Mac card never does, and Deny never does.
    public func needsPresence(for decision: ApprovalDecision) -> Bool {
        decision == .allow && presenceNote != nil && !needsMac
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
    /// When the Gateway expects it to finish, if it says so (it does not yet). Never a guess: nil means the
    /// Live Activity shows elapsed time and steps only.
    public var estimatedEnd: Date?

    public var fraction: Double { stepCount > 0 ? Double(step) / Double(stepCount) : 0 }

    public init(
        id: String, title: String, step: Int, stepCount: Int, detail: String, elapsed: String, startedAt: Date? = nil,
        estimatedEnd: Date? = nil
    ) {
        self.estimatedEnd = estimatedEnd
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
