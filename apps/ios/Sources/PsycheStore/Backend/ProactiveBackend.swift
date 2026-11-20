import Foundation

// Feed, Ideas, Goals and Scheduled work (the desktop Home's sections): what the Gateway's proactive side
// proposes and what it runs on a schedule. Gateway methods: feed.list/feedback, ideas.list/accept/dismiss,
// goals.list/get, scheduled.list/runs and automations.runs (for `retryAt`). Read-mostly on the phone:
// editing goals and schedules is a Mac thing.

public protocol ProactiveBackend: Sendable {
    func feed() async throws -> FeedSnapshot
    /// Records feedback on a post; nil clears it (undo).
    func setFeedback(postID: String, _ feedback: FeedFeedback?) async throws
    func ideas() async throws -> [IdeaItem]
    func acceptIdea(id: String) async throws
    func dismissIdea(id: String, reason: IdeaDismissReason) async throws
    func goals() async throws -> [GoalItem]
    func goalDetail(id: String) async throws -> GoalDetail
    func scheduled() async throws -> ScheduledOverview
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

public struct GoalDetail: Sendable, Equatable {
    public var goal: GoalItem
    public var milestones: [GoalMilestoneItem]
    public var linkedTasks: Int

    public init(goal: GoalItem, milestones: [GoalMilestoneItem] = [], linkedTasks: Int = 0) {
        self.goal = goal
        self.milestones = milestones
        self.linkedTasks = linkedTasks
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

    public init(id: String, title: String, summary: String = "", state: String, isRoutine: Bool = false, nextRunAt: Date? = nil, lastRunAt: Date? = nil) {
        self.id = id
        self.title = title
        self.summary = summary
        self.state = state
        self.isRoutine = isRoutine
        self.nextRunAt = nextRunAt
        self.lastRunAt = lastRunAt
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
    /// Newest first.
    public var runs: [ScheduledRunItem]
    public init(upcoming: [ScheduledJob] = [], runs: [ScheduledRunItem] = []) {
        self.upcoming = upcoming
        self.runs = runs
    }
    public static let skeleton = ScheduledOverview(
        upcoming: (0..<3).map { ScheduledJob(id: "sk\($0)", title: "Loading", state: "active") })
}
