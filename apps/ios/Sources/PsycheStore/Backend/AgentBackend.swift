import Foundation

// The agent sheet (§4.8): Activity, Approvals, Upcoming, Soul. Owner: the Home session (I5). Gateway
// methods: tasks.list/get/cancel/pause/resume, runs.*, scheduled.*, memory.persona.get.

public protocol AgentBackend: Sendable {
    func activity() async throws -> AgentActivity
    func persona() async throws -> PersonaSummary
    func cancelTask(id: String) async throws
}

public struct UpcomingItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    /// "Tomorrow 7:00 · every weekday".
    public var when: String
    public init(id: String, title: String, when: String) {
        self.id = id
        self.title = title
        self.when = when
    }
}

public struct RecentRun: Sendable, Equatable, Identifiable {
    public enum Outcome: String, Sendable { case done, failed, cancelled }
    public var id: String
    public var title: String
    public var outcome: Outcome
    public var time: String
    public init(id: String, title: String, outcome: Outcome, time: String) {
        self.id = id
        self.title = title
        self.outcome = outcome
        self.time = time
    }
}

public struct AgentActivity: Sendable, Equatable {
    public var needsYou: [NeedsYouItem]
    public var now: [RunningTask]
    public var nextUp: [UpcomingItem]
    public var recent: [RecentRun]
    public init(needsYou: [NeedsYouItem], now: [RunningTask], nextUp: [UpcomingItem], recent: [RecentRun]) {
        self.needsYou = needsYou
        self.now = now
        self.nextUp = nextUp
        self.recent = recent
    }
}

public struct PersonaSummary: Sendable, Equatable {
    public var name: String
    /// One paragraph from the persona files, read-only on the phone.
    public var summary: String
    public var files: [String]
    public init(name: String, summary: String, files: [String]) {
        self.name = name
        self.summary = summary
        self.files = files
    }
}
