import Foundation

/// Feed, Ideas, Goals and Scheduled fixtures. Acting on a card or idea removes it, as the Gateway does.
struct ProactiveState: Sendable {
    var cards = FixtureData.feedCards
    var ideas = FixtureData.ideaItems
    var goals = FixtureData.goalDetails
    var scheduled = FixtureData.scheduledOverview
}

extension FixtureBackend: ProactiveBackend {
    public func feed() async throws -> FeedSnapshot {
        await pause()
        return FeedSnapshot(cards: proactiveState.cards.filter { $0.feedback != .notInterested }, nextBriefAt: nil)
    }

    public func setFeedback(postID: String, _ feedback: FeedFeedback?) async throws {
        guard let index = proactiveState.cards.firstIndex(where: { $0.id == postID }) else { throw BackendError.notFound }
        proactiveState.cards[index].feedback = feedback
    }

    public func ideas() async throws -> [IdeaItem] {
        await pause()
        return proactiveState.ideas
    }

    public func acceptIdea(id: String) async throws {
        guard proactiveState.ideas.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        proactiveState.ideas.removeAll { $0.id == id }
    }

    public func dismissIdea(id: String, reason: IdeaDismissReason) async throws {
        guard proactiveState.ideas.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        proactiveState.ideas.removeAll { $0.id == id }
    }

    public func goals() async throws -> [GoalItem] {
        await pause()
        return proactiveState.goals.map(\.goal)
    }

    public func goalDetail(id: String) async throws -> GoalDetail {
        await pause()
        guard let detail = proactiveState.goals.first(where: { $0.goal.id == id }) else { throw BackendError.notFound }
        return detail
    }

    public func scheduled() async throws -> ScheduledOverview {
        await pause()
        return proactiveState.scheduled
    }
}

extension FixtureData {
    static let feedCards: [FeedCard] = [
        FeedCard(
            id: "post_1", title: "Heat pumps got cheaper this winter",
            body: "Installers report quotes down about 12 percent since October. Worth a look before you renew the lease on the boiler.",
            sources: [FeedSource(title: "Energy Weekly", url: "https://example.com/heat-pumps")], createdAt: Date(timeIntervalSince1970: 1_900_000_000)),
        FeedCard(id: "post_2", title: "Your passport expires in 5 months", body: "Some countries ask for six months of validity. Renewal takes about three weeks.", createdAt: Date(timeIntervalSince1970: 1_899_990_000)),
    ]

    static let ideaItems: [IdeaItem] = [
        IdeaItem(id: "idea_1", kind: "automation", title: "Summarize the Friday mail", body: "Every Friday at 4pm, a short digest of the week's unanswered mail.", effort: "5 min"),
        IdeaItem(id: "idea_2", kind: "task", title: "Cancel the unused gym subscription", body: "No visits since August; it renews on the 28th.", effort: "2 min"),
    ]

    static let goalDetails: [GoalDetail] = [
        GoalDetail(
            goal: GoalItem(id: "goal_1", title: "Run a half marathon", category: "health", status: "active", cadence: "weekly"),
            milestones: [
                GoalMilestoneItem(id: "m1", title: "Run 5 km without stopping", done: true),
                GoalMilestoneItem(id: "m2", title: "Run 10 km", done: false),
                GoalMilestoneItem(id: "m3", title: "Register for a race", done: false),
            ], linkedTasks: 2),
        GoalDetail(goal: GoalItem(id: "goal_2", title: "Save for a deposit", category: "finance", status: "candidate")),
    ]

    static let scheduledOverview = ScheduledOverview(
        upcoming: [
            ScheduledJob(id: "auto_1", title: "Pay the electricity bill", summary: "Checks the bill and asks before paying.", state: "active", nextRunAt: Date(timeIntervalSince1970: 1_900_100_000)),
            ScheduledJob(id: "auto_2", title: "Daily brief", state: "active", isRoutine: true, nextRunAt: Date(timeIntervalSince1970: 1_900_200_000)),
        ],
        runs: [
            ScheduledRunItem(id: "run_1", title: "Daily brief", state: .succeeded, startedAt: Date(timeIntervalSince1970: 1_899_900_000), summary: "Sent."),
            ScheduledRunItem(id: "run_2", title: "Pay the electricity bill", state: .running, startedAt: Date(timeIntervalSince1970: 1_899_950_000), retryAt: Date(timeIntervalSince1970: 1_900_000_300)),
        ])
}
