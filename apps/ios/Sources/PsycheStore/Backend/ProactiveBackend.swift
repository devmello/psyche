import Foundation

// Feed, Ideas, Goals and Scheduled work (the desktop Home's sections): what the Gateway's proactive side
// proposes and what it runs on a schedule. Gateway methods: feed.list/feedback, ideas.list/accept/dismiss,
// goals.list/get/update (status only), goals.decide/archive/milestone, scheduled.list/runs/pause,
// automations.run and automations.runs (Past runs, and `retryAt`), automations.list/create/update/delete (the Scheduled
// editor). A goal's title, plan and check-in cadence stay a Mac thing; an automation triggered by an event or a
// watch is edited on the Mac.

public protocol ProactiveBackend: Sendable {
    func feed() async throws -> FeedSnapshot
    /// Records feedback on a post; nil clears it (undo).
    func setFeedback(postID: String, _ feedback: FeedFeedback?) async throws
    func ideas() async throws -> [IdeaItem]
    func acceptIdea(id: String) async throws
    func dismissIdea(id: String, reason: IdeaDismissReason) async throws
    func goals() async throws -> [GoalItem]
    func goalDetail(id: String) async throws -> GoalDetail
    /// Changes a goal's status and returns the goal as the Gateway now holds it.
    func setGoalStatus(id: String, _ status: GoalStatusChange) async throws -> GoalDetail
    /// Confirms, defers or rejects a suggested goal and returns it as the Gateway now holds it.
    func decideGoal(id: String, _ decision: GoalDecision) async throws -> GoalItem
    /// Archives a goal and stops its check-ins. Nothing is deleted.
    func archiveGoal(id: String) async throws -> GoalItem
    /// Adds, completes or removes a milestone and returns the goal page the Gateway now holds.
    func changeMilestone(goalID: String, _ change: GoalMilestoneChange) async throws -> GoalDetail
    /// Creates a stated goal (active at once), as the Mac's Add goal dialog does, and returns it.
    func createGoal(title: String, category: GoalCategoryChoice) async throws -> GoalDetail
    func scheduled() async throws -> ScheduledOverview
    /// Pauses (`paused: true`) or resumes an automation or routine; returns its new state.
    func setScheduledPaused(id: String, paused: Bool) async throws -> String
    /// Runs an automation or routine now, outside its schedule.
    func runScheduledNow(id: String) async throws
    /// The automation behind a scheduled item, with its prompt and schedule, for the editor.
    func automation(id: String) async throws -> AutomationDetail
    /// Creates an automation and returns its id.
    func createAutomation(_ create: AutomationCreate) async throws -> String
    /// Sends only the changed fields. Nothing to send is a no-op.
    func updateAutomation(id: String, changes: AutomationChanges) async throws
    /// Deletes an automation. The Gateway refuses the ones it runs for itself.
    func deleteAutomation(id: String) async throws
    /// One page of an automation's run history, newest first (the editor's Past runs list). `nextCursor` nil is the last page.
    func automationRuns(id: String, cursor: String?) async throws -> AutomationRunPage
    /// Asks the model for one next step for a goal (`goals.suggest`). Returns the id of the idea it offers, to Start or
    /// Not now on Home (`ideas()` has it); nil when there is none. Runs only when the owner asks, and nothing starts.
    func suggestNextStep(goalID: String) async throws -> String?
    /// Links a task or an automation to a goal (`goals.link`), as the desktop's Link dialog does.
    func linkGoal(goalID: String, _ target: GoalLinkTarget) async throws
    /// Unlinks a task or an automation from a goal (`goals.link` with `unlink`). The task or automation itself stays.
    func unlinkGoal(goalID: String, _ target: GoalLinkTarget) async throws
}

// MARK: Feed

public enum FeedFeedback: String, Sendable, Equatable { case like, save, notInterested = "not_interested" }

public struct FeedSource: Sendable, Equatable, Hashable {
    public var title: String
    public var url: String
    public init(title: String, url: String) {
        self.title = title
        self.url = url
    }
}

public struct FeedCard: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var body: String
    public var sources: [FeedSource]
    public var createdAt: Date?
    public var feedback: FeedFeedback?

    public init(id: String, title: String, body: String, sources: [FeedSource] = [], createdAt: Date? = nil, feedback: FeedFeedback? = nil) {
        self.id = id
        self.title = title
        self.body = body
        self.sources = sources
        self.createdAt = createdAt
        self.feedback = feedback
    }
}

public struct FeedSnapshot: Sendable, Equatable {
    public var cards: [FeedCard]
    public var nextBriefAt: Date?
    public init(cards: [FeedCard], nextBriefAt: Date? = nil) {
        self.cards = cards
        self.nextBriefAt = nextBriefAt
    }
    public static let skeleton = FeedSnapshot(cards: (0..<3).map { FeedCard(id: "sk\($0)", title: "Loading the feed", body: "Loading the feed") })
}

// MARK: Ideas

public enum IdeaDismissReason: String, Sendable, Equatable { case notNow = "not_now", notInterested = "not_interested" }

public struct IdeaItem: Sendable, Equatable, Identifiable {
    public var id: String
    /// "task", "automation", "skill", "goal" or "connector".
    public var kind: String
    public var title: String
    public var body: String
    public var effort: String
    public var createdAt: Date?

    public init(id: String, kind: String, title: String, body: String, effort: String = "", createdAt: Date? = nil) {
        self.id = id
        self.kind = kind
        self.title = title
        self.body = body
        self.effort = effort
        self.createdAt = createdAt
    }
    public static let skeleton = (0..<3).map { IdeaItem(id: "sk\($0)", kind: "task", title: "Loading ideas", body: "Loading ideas") }
}

// MARK: Goals

/// The statuses a phone can set on a goal (`goals.update`). Archiving is `archiveGoal`.
public enum GoalStatusChange: String, Sendable, Equatable { case active, paused, done }

/// What the owner can decide about a suggested goal (`goals.decide`). Nothing is created before `confirm`.
public enum GoalDecision: String, Sendable, Equatable { case confirm, reject, later }

/// A milestone edit (`goals.milestone`): add one (no id), mark one done or undone, or remove one.
public enum GoalMilestoneChange: Sendable, Equatable {
    case add(title: String, dueAt: Date?)
    case setDone(id: String, Bool)
    case remove(id: String)
}

/// The categories `goals.create` takes; the same eight as the protocol's GoalCategory.
public enum GoalCategoryChoice: String, Sendable, Equatable, CaseIterable, Identifiable {
    case health, finance, career, relationships, productivity, learning, home, other
    public var id: String { rawValue }
}

/// What the Add goal sheet holds before it is sent. A goal needs a title once its spaces are trimmed.
public struct GoalDraft: Sendable, Equatable {
    public var title: String
    public var category: GoalCategoryChoice

    public init(title: String = "", category: GoalCategoryChoice = .other) {
        self.title = title
        self.category = category
    }

    public var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    public var isValid: Bool { !trimmedTitle.isEmpty }
}

public struct GoalItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    /// "health", "finance", …
    public var category: String
    /// "candidate", "active", "paused", "done".
    public var status: String
    public var cadence: String?
    public var nextCheckinAt: Date?

    public init(id: String, title: String, category: String, status: String, cadence: String? = nil, nextCheckinAt: Date? = nil) {
        self.id = id
        self.title = title
        self.category = category
        self.status = status
        self.cadence = cadence
        self.nextCheckinAt = nextCheckinAt
    }
    public static let skeleton = (0..<3).map { GoalItem(id: "sk\($0)", title: "Loading goals", category: "other", status: "active") }
}

public struct GoalMilestoneItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var dueAt: Date?
    public var done: Bool
    public init(id: String, title: String, dueAt: Date? = nil, done: Bool) {
        self.id = id
        self.title = title
        self.dueAt = dueAt
        self.done = done
    }
}

/// A task or an automation linked to a goal: what `goals.link` takes (`taskId` or `automationId`) and what
/// `goals.get` returns in `links`.
public enum GoalLinkTarget: Sendable, Equatable, Hashable {
    case task(String)
    case automation(String)

    public var id: String {
        switch self {
        case .task(let id), .automation(let id): id
        }
    }

    public var isTask: Bool {
        if case .task = self { true } else { false }
    }
}

public struct GoalDetail: Sendable, Equatable {
    public var goal: GoalItem
    public var milestones: [GoalMilestoneItem]
    public var linkedTasks: Int
    /// The tasks and automations linked to the goal, in the order `goals.get` gives them (`links`).
    public var links: [GoalLinkTarget]

    public init(goal: GoalItem, milestones: [GoalMilestoneItem] = [], linkedTasks: Int = 0, links: [GoalLinkTarget] = []) {
        self.goal = goal
        self.milestones = milestones
        self.linkedTasks = linkedTasks
        self.links = links
    }

    /// Done milestones over all milestones; nil when the goal has none (progress is then unknown, not zero).
    public var progress: Double? {
        guard !milestones.isEmpty else { return goal.status == "done" ? 1 : nil }
        return Double(milestones.filter(\.done).count) / Double(milestones.count)
    }
}

// MARK: Scheduled

public struct ScheduledJob: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    /// One line of what it does; empty for Psyche's own routines.
    public var summary: String
    /// "active", "paused" or "off".
    public var state: String
    public var isRoutine: Bool
    public var nextRunAt: Date?
    public var lastRunAt: Date?
    /// Run now asks first. True unless the item is a routine with no approvals it may need.
    public var confirmsRunNow: Bool

    public init(
        id: String, title: String, summary: String = "", state: String, isRoutine: Bool = false, nextRunAt: Date? = nil, lastRunAt: Date? = nil,
        confirmsRunNow: Bool = true
    ) {
        self.id = id
        self.title = title
        self.summary = summary
        self.state = state
        self.isRoutine = isRoutine
        self.nextRunAt = nextRunAt
        self.lastRunAt = lastRunAt
        self.confirmsRunNow = confirmsRunNow
    }
}

public enum ScheduledRunState: String, Sendable, Equatable {
    case running, waiting, succeeded, notVerified = "not_verified", failed, skipped, cancelled
}

public struct ScheduledRunItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var state: ScheduledRunState
    public var startedAt: Date?
    public var summary: String?
    public var reason: String?
    /// The run is waiting for its next attempt after a transient model error: when that attempt is due.
    public var retryAt: Date?

    public init(id: String, title: String, state: ScheduledRunState, startedAt: Date? = nil, summary: String? = nil, reason: String? = nil, retryAt: Date? = nil) {
        self.id = id
        self.title = title
        self.state = state
        self.startedAt = startedAt
        self.summary = summary
        self.reason = reason
        self.retryAt = retryAt
    }
}

public struct ScheduledOverview: Sendable, Equatable {
    /// Active items with a next time, soonest first.
    public var upcoming: [ScheduledJob]
    /// Every automation and routine, whatever its state: active first, then paused, then off.
    public var items: [ScheduledJob]
    /// Newest first.
    public var runs: [ScheduledRunItem]
    public init(upcoming: [ScheduledJob] = [], items: [ScheduledJob] = [], runs: [ScheduledRunItem] = []) {
        self.upcoming = upcoming
        self.items = items
        self.runs = runs
    }
    /// The active items with a next time, soonest first.
    public static func upcomingOf(_ items: [ScheduledJob]) -> [ScheduledJob] {
        items.filter { $0.state == "active" && $0.nextRunAt != nil }
            .sorted { ($0.nextRunAt ?? .distantFuture) < ($1.nextRunAt ?? .distantFuture) }
    }
    public static let skeleton = ScheduledOverview(
        items: (0..<3).map { ScheduledJob(id: "sk\($0)", title: "Loading", state: "active") })
}

// MARK: Automation runs

/// A run's state as an automation's past runs show it (`automations.runs`).
public enum AutomationRunStatus: String, Sendable, Equatable {
    case running, done, noReply = "no_reply", failed, cancelled, skipped
}

/// One run of an automation. `summary` is what the run said; for a failed run, why it failed.
public struct AutomationRunItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var status: AutomationRunStatus
    public var startedAt: Date
    public var endedAt: Date?
    public var summary: String?
    /// The task the run worked in. Its run page (`TaskRunView`) opens from here; nil means no tap.
    public var taskID: String?

    public init(id: String, status: AutomationRunStatus, startedAt: Date, endedAt: Date? = nil, summary: String? = nil, taskID: String? = nil) {
        self.id = id
        self.status = status
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.summary = summary
        self.taskID = taskID
    }

    /// How long the run took; nil while it is still running.
    public var duration: TimeInterval? { endedAt.map { max(0, $0.timeIntervalSince(startedAt)) } }
}

public struct AutomationRunPage: Sendable, Equatable {
    public var runs: [AutomationRunItem]
    public var nextCursor: String?
    public init(runs: [AutomationRunItem], nextCursor: String? = nil) {
        self.runs = runs
        self.nextCursor = nextCursor
    }
}
