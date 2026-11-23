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

    public init(canPause: Bool = false, canResume: Bool = false, canRetry: Bool = false, canSteer: Bool = false, canCancel: Bool = false) {
        self.canPause = canPause
        self.canResume = canResume
        self.canRetry = canRetry
        self.canSteer = canSteer
        self.canCancel = canCancel
    }

    public var isEmpty: Bool { !(canPause || canResume || canRetry || canSteer || canCancel) }

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

    public init(taskID: String, title: String, state: TaskRunState, startedAt: Date?, endedAt: Date?, summary: String?, steps: [TaskRunStep]) {
        self.taskID = taskID
        self.title = title
        self.state = state
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.summary = summary
        self.steps = steps
    }

    public var controls: TaskRunControls { .available(for: state) }
}
