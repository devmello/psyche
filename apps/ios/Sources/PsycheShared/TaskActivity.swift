import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

// The Live Activity for a running task (companion §3.6). The app and the Widgets extension both compile
// this, so the content state is the one place that says what may appear where:
// - Lock Screen card: step n of m, a status and a start time. The task's title and what the step is doing
//   appear when the owner opts in ("Task titles on the Lock Screen"), or otherwise only while the phone is
//   unlocked (Notification Center, a banner); locked, iOS's privacy redaction keeps them off the card.
// - Dynamic Island (shown only on an unlocked phone): also the task's title, what the current step is doing,
//   what it is asking for and, for an approval the owner may answer there, its id.
// These fields exist because the app starts and updates the activity itself (M2-lite); nothing leaves the phone. If Gateway push updates arrive later (companion §3.6), the push
//   payload must leave `islandTitle`, `detail`, `asking` and `inlineApprovalID` out unless the owner opted in.
// Never tool arguments or results.

public enum TaskActivityStatus: String, Codable, Hashable, Sendable {
    case running, needsApproval, done, failed
}

public struct TaskActivityContent: Codable, Hashable, Sendable {
    /// 1-based step being worked on. Meaningless when `stepCount` is 0.
    public var step: Int
    /// 0 when the Gateway does not know how many steps there are: the activity then says "Running".
    public var stepCount: Int
    public var status: TaskActivityStatus
    public var startedAt: Date
    /// Set once the task finished, so the elapsed time stops.
    public var endedAt: Date?
    /// Present only with Settings -> "Task titles on the Lock Screen" on.
    public var title: String?
    /// The task's title for the Dynamic Island, which shows only on an unlocked phone.
    public var islandTitle: String?
    /// What the current step is doing ("reading 12 files"). Dynamic Island only.
    public var detail: String?
    /// What the task is waiting for the owner to approve ("Send the Q3 summary to Dana?"). Dynamic Island only.
    public var asking: String?
    /// The approval the expanded island may answer with its own Deny and Approve buttons. Set only for a
    /// plain write approval; a presence-gated one (payments, anything Face ID must gate) leaves it nil and
    /// the island offers "Review…", which opens the full card in the app. Dynamic Island only.
    public var inlineApprovalID: String?

    public init(
        step: Int, stepCount: Int, status: TaskActivityStatus, startedAt: Date, endedAt: Date? = nil,
        title: String? = nil, islandTitle: String? = nil, detail: String? = nil, asking: String? = nil,
        inlineApprovalID: String? = nil
    ) {
        self.step = step
        self.stepCount = stepCount
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.title = title
        self.islandTitle = islandTitle
        self.detail = detail
        self.asking = asking
        self.inlineApprovalID = inlineApprovalID
    }

    /// What a future Gateway push update may carry (companion §3.6): progress, status, times and the opted-in
    /// title. The Dynamic Island's extra text stays on the phone.
    public var forPush: TaskActivityContent {
        var copy = self
        copy.islandTitle = nil
        copy.detail = nil
        copy.asking = nil
        copy.inlineApprovalID = nil
        return copy
    }

    /// "Step 3 of 7", or nil when the step count is unknown.
    public var stepLabel: String? { hasStepCount ? "Step \(clampedStep) of \(stepCount)" : nil }

    /// One word for the island's status: "Running", "Needs your OK", "Done", "Failed".
    public var statusWord: String {
        switch status {
        case .running: "Running"
        case .needsApproval: "Needs your OK"
        case .done: "Done"
        case .failed: "Failed"
        }
    }

    /// The island shows its own Deny and Approve buttons: it is waiting on an approval that may be answered there.
    public var answersInline: Bool { status == .needsApproval && inlineApprovalID != nil }

    /// 0...1 for the ring; nil when the step count is unknown.
    public var fraction: Double? {
        guard hasStepCount else { return nil }
        let (total, finished) = segments
        return total > 0 ? Double(finished) / Double(total) : nil
    }

    public var hasStepCount: Bool { stepCount > 0 }

    /// "Step 3 of 7 · running", or "Running" when the step count is unknown.
    public var statusLine: String {
        switch status {
        case .running: hasStepCount ? "Step \(clampedStep) of \(stepCount) · running" : "Running"
        case .needsApproval: "Needs approval"
        case .done: "Done"
        case .failed: "Failed"
        }
    }

    public var clampedStep: Int { min(max(step, 1), max(stepCount, 1)) }

    /// How many progress segments to draw (capped, so a long checklist stays readable) and how many are
    /// finished. The current step is the first unfinished one.
    public var segments: (total: Int, finished: Int) {
        guard hasStepCount else { return (0, 0) }
        let total = min(stepCount, 12)
        let finishedSteps: Int
        switch status {
        case .done: finishedSteps = stepCount
        case .running, .needsApproval, .failed: finishedSteps = clampedStep - 1
        }
        let finished = stepCount > total ? Int((Double(finishedSteps) / Double(stepCount) * Double(total)).rounded(.down)) : finishedSteps
        return (total, min(finished, total))
    }

    /// The deep link a tap on the activity follows; the app's router allowlist maps it (`Route(appPath:)`).
    public static func url(forTask id: String) -> URL? {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        guard let escaped = id.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "psyche://task/\(escaped)")
    }
}

/// Where the island's Deny and Approve buttons hand their answer to the app. `AnswerApprovalIntent` runs in
/// the app's process (a `LiveActivityIntent`); the app installs the handler at launch, before any intent can
/// run. In the Widgets extension it stays nil.
@MainActor
public enum IslandAnswers {
    public static var handler: (@MainActor (_ approvalID: String, _ approve: Bool) async -> Void)?

    public static func answer(_ approvalID: String, approve: Bool) async {
        await handler?(approvalID, approve)
    }
}

#if canImport(ActivityKit) && os(iOS)
public struct PsycheTaskAttributes: ActivityAttributes {
    public typealias ContentState = TaskActivityContent

    public var taskID: String

    public init(taskID: String) {
        self.taskID = taskID
    }
}
#endif
