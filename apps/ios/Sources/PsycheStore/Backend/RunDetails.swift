import Foundation

// A run's trace as the run details screen shows it: its steps in seq order (`runs.steps`) and the frames
// Psyche saw during it (`runs.frames`). Pure values, so paging and decoding are testable without a Gateway.

/// The kinds of a run step the Gateway sends (`RunStepKind`). A kind this build does not know keeps its place
/// in the list with a generic icon, never a guess.
public enum RunStepKindName: String, Sendable, Equatable, CaseIterable {
    case thinking, model, tool, approval, question, subagent, text, memory, artifact, note
}

/// One step of a run's trace, as `runs.steps` sends it. `label` is the status line, `doneLabel` the past tense
/// once the step ended; both are redacted by the Gateway.
public struct RunStepRow: Sendable, Equatable, Identifiable {
    public var id: String
    public var seq: Int
    /// Nil for a kind this build does not know.
    public var kind: RunStepKindName?
    public var status: TaskRunStep.Status
    public var label: String
    public var doneLabel: String?
    /// A domain, file or recipient, redacted. Nil when the step has none.
    public var target: String?
    public var startedAt: Date?
    public var endedAt: Date?

    public init(
        id: String, seq: Int, kind: RunStepKindName?, status: TaskRunStep.Status, label: String,
        doneLabel: String? = nil, target: String? = nil, startedAt: Date? = nil, endedAt: Date? = nil
    ) {
        self.id = id
        self.seq = seq
        self.kind = kind
        self.status = status
        self.label = label
        self.doneLabel = doneLabel
        self.target = target
        self.startedAt = startedAt
        self.endedAt = endedAt
    }

    /// The line the list shows: the past tense once the step ended ok, else the status line.
    public var title: String {
        (status == .ok ? doneLabel : nil) ?? label
    }
}

/// One `runs.steps` page: the steps after the request's `afterSeq`, and the seq to ask for next (nil when the
/// run has no more steps).
public struct RunStepPage: Sendable, Equatable {
    public var steps: [RunStepRow]
    public var nextSeq: Int?

    public init(steps: [RunStepRow], nextSeq: Int?) {
        self.steps = steps
        self.nextSeq = nextSeq
    }
}

/// One frame from `runs.frames`: a screenshot Psyche saw, placed on the step it belongs to.
public struct RunFrameRef: Sendable, Equatable, Identifiable {
    public var seq: Int
    public var stepID: String?
    public var width: Int
    public var height: Int
    /// The Gateway dropped the image after the replay retention; the row stays, the picture does not come.
    public var expired: Bool

    public var id: Int { seq }

    public init(seq: Int, stepID: String?, width: Int, height: Int, expired: Bool = false) {
        self.seq = seq
        self.stepID = stepID
        self.width = width
        self.height = height
        self.expired = expired
    }
}

/// The steps the screen has loaded so far. Pages append in seq order and a step already held is never added
/// twice, so a page that overlaps the last one (a retried request, a step written between two pages) is safe.
public struct RunStepList: Sendable, Equatable {
    public private(set) var steps: [RunStepRow] = []
    /// The seq to pass as `afterSeq` for the next page. Nil once the Gateway says the run has no more.
    public private(set) var nextSeq: Int?

    public init() {}

    public var hasMore: Bool { nextSeq != nil }

    public mutating func append(_ page: RunStepPage) {
        let held = Set(steps.map(\.seq))
        let fresh = page.steps.filter { !held.contains($0.seq) }
        steps = (steps + fresh).sorted { $0.seq < $1.seq }
        nextSeq = page.nextSeq
    }
}

/// How many steps the run details screen asks for per page.
public enum RunStepPaging {
    public static let pageSize = 50
}
