import Foundation

// A task's run detail (the agent sheet's run page): the task's state, its latest run's steps, and which
// owner controls the state allows. Pure values so the controls can be tested without a Gateway.

/// The task's status as the phone shows it (mirrors the Gateway's `TaskStatus`).
public enum TaskRunState: String, Sendable, Equatable, CaseIterable {
    case queued, running
    case awaitingInput = "awaiting_input"
    case awaitingApproval = "awaiting_approval"
    case paused, done, failed, cancelled

    /// Still working or waiting on the owner, so the page keeps refreshing.
    public var isLive: Bool {
        switch self {
        case .queued, .running, .awaitingInput, .awaitingApproval, .paused: true
        case .done, .failed, .cancelled: false
        }
    }
}

/// Which owner controls the page shows. Each is true only when the Gateway accepts it in that state.
public struct TaskRunControls: Sendable, Equatable {
    public var canPause: Bool
    public var canResume: Bool
    public var canRetry: Bool
    public var canSteer: Bool
    public var canCancel: Bool
    /// `tasks.update` changes a specialist job's budget or deadline. Only a job that is still live has one.
    public var canEdit: Bool

    public init(
        canPause: Bool = false, canResume: Bool = false, canRetry: Bool = false, canSteer: Bool = false,
        canCancel: Bool = false, canEdit: Bool = false
    ) {
        self.canPause = canPause
        self.canResume = canResume
        self.canRetry = canRetry
        self.canSteer = canSteer
        self.canCancel = canCancel
        self.canEdit = canEdit
    }

    public var isEmpty: Bool { !(canPause || canResume || canRetry || canSteer || canCancel || canEdit) }

    /// `tasks.pause` pauses a running task, `tasks.resume` a paused one, `tasks.retry` a failed or cancelled one,
    /// `tasks.steer` a running one, and `tasks.cancel` any task that has not ended.
    public static func available(for state: TaskRunState) -> TaskRunControls {
        switch state {
        case .running: TaskRunControls(canPause: true, canSteer: true, canCancel: true)
        case .queued, .awaitingInput, .awaitingApproval: TaskRunControls(canCancel: true)
        case .paused: TaskRunControls(canResume: true, canCancel: true)
        case .failed, .cancelled: TaskRunControls(canRetry: true)
        case .done: TaskRunControls()
        }
    }
}

/// A specialist job's limits as the Gateway's task carries them: the budget's token, cost and wall-clock limits
/// and its deadline. Nil in a field the Gateway did not send.
public struct TaskLimits: Sendable, Equatable {
    public var tokens: Int?
    public var costUsd: Double?
    public var minutes: Int?
    public var deadline: Date?

    public init(tokens: Int? = nil, costUsd: Double? = nil, minutes: Int? = nil, deadline: Date? = nil) {
        self.tokens = tokens
        self.costUsd = costUsd
        self.minutes = minutes
        self.deadline = deadline
    }
}

/// The fields the owner changed on a job's limits. Nil means unchanged and is never sent. A deadline can move
/// but not clear: `tasks.update` takes no null deadline.
public struct TaskChanges: Sendable, Equatable {
    public var tokens: Int?
    public var costUsd: Double?
    public var minutes: Int?
    public var deadline: Date?

    public init(tokens: Int? = nil, costUsd: Double? = nil, minutes: Int? = nil, deadline: Date? = nil) {
        self.tokens = tokens
        self.costUsd = costUsd
        self.minutes = minutes
        self.deadline = deadline
    }

    public var isEmpty: Bool { tokens == nil && costUsd == nil && minutes == nil && deadline == nil }
}

public struct TaskRunStep: Sendable, Equatable, Identifiable {
    public enum Status: String, Sendable, Equatable {
        case pending, running, ok, failed, waiting, cancelled, skipped, denied
    }

    public var id: String
    public var label: String
    public var status: Status
    public var startedAt: Date?
    public var endedAt: Date?
    /// The step's short result: the error message when it failed, else the first line of its output. nil when none.
    public var result: String?

    public init(id: String, label: String, status: Status, startedAt: Date? = nil, endedAt: Date? = nil, result: String? = nil) {
        self.id = id
        self.label = label
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.result = result
    }
}

public struct TaskRunDetail: Sendable, Equatable {
    public var taskID: String
    public var title: String
    public var state: TaskRunState
    public var startedAt: Date?
    public var endedAt: Date?
    public var summary: String?
    public var steps: [TaskRunStep]
    /// The job's limits, when the task is a specialist's job. Nil for any other task.
    public var limits: TaskLimits?
    /// The latest run's id, for the run details screen. Nil when the task has no run yet.
    public var runID: String?

    public init(
        taskID: String, title: String, state: TaskRunState, startedAt: Date?, endedAt: Date?, summary: String?,
        steps: [TaskRunStep], limits: TaskLimits? = nil, runID: String? = nil
    ) {
        self.runID = runID
        self.taskID = taskID
        self.title = title
        self.state = state
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.summary = summary
        self.steps = steps
        self.limits = limits
    }

    public var controls: TaskRunControls {
        var controls = TaskRunControls.available(for: state)
        controls.canEdit = limits != nil && state.isLive
        return controls
    }
}
