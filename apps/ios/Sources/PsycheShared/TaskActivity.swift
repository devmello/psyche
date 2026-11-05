import Foundation
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

// The Live Activity for a running task (companion §3.6). The app and the Widgets extension both compile
// this, so the content state is the one place that says what may appear on the Lock Screen: step n of m,
// a status, a start time and, only when the owner opts in, the task title. Never task text, tool
// arguments or results.

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

    public init(
        step: Int, stepCount: Int, status: TaskActivityStatus, startedAt: Date, endedAt: Date? = nil,
        title: String? = nil
    ) {
        self.step = step
        self.stepCount = stepCount
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.title = title
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

#if canImport(ActivityKit) && os(iOS)
public struct PsycheTaskAttributes: ActivityAttributes {
    public typealias ContentState = TaskActivityContent

    public var taskID: String

    public init(taskID: String) {
        self.taskID = taskID
    }
}
#endif
