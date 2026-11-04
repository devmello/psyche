import Foundation

// The shapes the UI reads. The Gateway is the source of truth (A6): these are the cached snapshots,
// so they stay small, value-typed and Sendable. I2 fills them from the wire; today fixtures do.

// MARK: Home

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
    /// The chat thread this came from, for questions and tasks.
    public var threadID: String?

    public init(
        id: String, kind: Kind, title: String, source: String, time: String,
        approval: ApprovalDetail? = nil, threadID: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.source = source
        self.time = time
        self.approval = approval
        self.threadID = threadID
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

    public var fraction: Double { stepCount > 0 ? Double(step) / Double(stepCount) : 0 }

    public init(id: String, title: String, step: Int, stepCount: Int, detail: String, elapsed: String) {
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

    public init(id: String, initials: String, text: String) {
        self.id = id
        self.initials = initials
        self.text = text
    }
}

// MARK: Chat

public struct ChatThreadSummary: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    /// "Running · step 3 of 7", "Waiting for you", or the last-activity time.
    public var status: String
    public var statusKind: Status
    public var isMain: Bool
    public var updated: String

    public enum Status: Sendable { case neutral, needsYou, running }

    public init(id: String, title: String, status: String, statusKind: Status, isMain: Bool, updated: String) {
        self.id = id
        self.title = title
        self.status = status
        self.statusKind = statusKind
        self.isMain = isMain
        self.updated = updated
    }
}

public struct ChatThread: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var status: String
    public var statusKind: ChatThreadSummary.Status
    public var items: [ChatItem]

    public init(id: String, title: String, status: String, statusKind: ChatThreadSummary.Status, items: [ChatItem]) {
        self.id = id
        self.title = title
        self.status = status
        self.statusKind = statusKind
        self.items = items
    }
}

public enum ChatItem: Sendable, Equatable, Identifiable {
    case user(id: String, text: String)
    case assistant(id: String, text: String, streaming: Bool)
    case toolCall(id: String, symbol: String, summary: String)
    case question(id: String, title: String, options: [ChatOption])
    case evidence(id: String, label: String, parts: [String])

    public var id: String {
        switch self {
        case .user(let id, _), .assistant(let id, _, _), .toolCall(let id, _, _),
             .question(let id, _, _), .evidence(let id, _, _):
            id
        }
    }
}

public struct ChatOption: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var detail: String

    public init(id: String, title: String, detail: String) {
        self.id = id
        self.title = title
        self.detail = detail
    }
}

// MARK: Memory

public struct MemorySnapshot: Sendable, Equatable {
    public var todos: [TodoItem]
    public var projects: [ProjectItem]
    public var people: [PersonItem]
    public var leftOff: LeftOff

    public init(todos: [TodoItem], projects: [ProjectItem], people: [PersonItem], leftOff: LeftOff) {
        self.todos = todos
        self.projects = projects
        self.people = people
        self.leftOff = leftOff
    }
}

public struct TodoItem: Sendable, Equatable, Identifiable {
    public enum Bucket: Sendable { case thisWeek, later }

    public var id: String
    public var title: String
    /// "Fri · Home · $1,850".
    public var meta: String
    public var bucket: Bucket
    public var needsYou: Bool
    public var done: Bool

    public init(id: String, title: String, meta: String, bucket: Bucket, needsYou: Bool = false, done: Bool = false) {
        self.id = id
        self.title = title
        self.meta = meta
        self.bucket = bucket
        self.needsYou = needsYou
        self.done = done
    }
}

public struct ProjectItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var detail: String
    public var fraction: Double

    public init(id: String, title: String, detail: String, fraction: Double) {
        self.id = id
        self.title = title
        self.detail = detail
        self.fraction = fraction
    }
}

public struct PersonItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var initials: String
    public var detail: String

    public init(id: String, name: String, initials: String, detail: String) {
        self.id = id
        self.name = name
        self.initials = initials
        self.detail = detail
    }
}

public struct LeftOff: Sendable, Equatable {
    public var title: String
    public var text: String
    public var evidence: [String]

    public init(title: String, text: String, evidence: [String]) {
        self.title = title
        self.text = text
        self.evidence = evidence
    }
}

// MARK: Search

public struct SearchResults: Sendable, Equatable {
    public struct Answer: Sendable, Equatable {
        public var text: String
        public var emphasis: String
        public var evidence: [String]
        public init(text: String, emphasis: String, evidence: [String]) {
            self.text = text
            self.emphasis = emphasis
            self.evidence = evidence
        }
    }

    public struct Hit: Sendable, Equatable, Identifiable {
        public enum Group: String, Sendable, CaseIterable {
            case todo = "To-do"
            case chatsAndFiles = "Chats and files"
            case people = "People"
        }

        public var id: String
        public var group: Group
        public var symbol: String
        public var title: String
        public var detail: String

        public init(id: String, group: Group, symbol: String, title: String, detail: String) {
            self.id = id
            self.group = group
            self.symbol = symbol
            self.title = title
            self.detail = detail
        }
    }

    public var answer: Answer?
    public var hits: [Hit]

    public init(answer: Answer?, hits: [Hit]) {
        self.answer = answer
        self.hits = hits
    }
}

// MARK: Skeletons

// Placeholder shapes drawn redacted while the first load runs, so the skeleton matches the loaded layout.

extension HomeSnapshot {
    public static let skeleton = HomeSnapshot(
        needsYou: (1...2).map {
            NeedsYouItem(id: "sk\($0)", kind: .approval, title: "Placeholder title for a row", source: "Source", time: "0:00")
        },
        running: [RunningTask(id: "skr", title: "Placeholder task title", step: 1, stepCount: 4, detail: "detail", elapsed: "1 min")],
        today: (1...2).map { BriefItem(id: "skb\($0)", text: "Placeholder text for a line of the brief that wraps onto a second line.", evidenceLabel: "Because", evidence: ["source"]) },
        keepInTouch: [], updatedAt: .distantPast)
}

extension MemorySnapshot {
    public static let skeleton = MemorySnapshot(
        todos: (1...3).map { TodoItem(id: "skt\($0)", title: "Placeholder to-do title", meta: "Day · Project", bucket: .thisWeek) },
        projects: [], people: [],
        leftOff: LeftOff(title: "Placeholder.", text: "Placeholder text for where you left off, on two lines of text.", evidence: ["source"]))
}

extension [ChatThreadSummary] {
    public static let skeleton: [ChatThreadSummary] = (1...4).map {
        ChatThreadSummary(id: "skc\($0)", title: "Placeholder chat title", status: "Status", statusKind: .neutral, isMain: false, updated: "0:00")
    }
}

extension ChatThread {
    public static let skeleton = ChatThread(
        id: "sk", title: "Chat", status: "", statusKind: .neutral,
        items: [
            .assistant(id: "sk1", text: "Placeholder text for a message that wraps across two or three lines in the thread.", streaming: false),
            .toolCall(id: "sk2", symbol: "doc", summary: "Placeholder tool call summary"),
        ])
}
