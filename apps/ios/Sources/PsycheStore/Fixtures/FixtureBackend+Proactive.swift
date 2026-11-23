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

    public func createGoal(title: String, category: GoalCategoryChoice) async throws -> GoalDetail {
        await pause()
        let detail = GoalDetail(goal: GoalItem(id: "goal_\(proactiveState.goals.count + 1)", title: title, category: category.rawValue, status: "active"))
        proactiveState.goals.append(detail)
        return detail
    }

    public func setGoalStatus(id: String, _ status: GoalStatusChange) async throws -> GoalDetail {
        guard let index = proactiveState.goals.firstIndex(where: { $0.goal.id == id }) else { throw BackendError.notFound }
        proactiveState.goals[index].goal.status = status.rawValue
        return proactiveState.goals[index]
    }

    public func scheduled() async throws -> ScheduledOverview {
        await pause()
        return proactiveState.scheduled
    }

    public func setScheduledPaused(id: String, paused: Bool) async throws -> String {
        guard let index = proactiveState.scheduled.items.firstIndex(where: { $0.id == id }) else { throw BackendError.notFound }
        // An off routine has no pause: its Settings section turns it on and off.
        guard proactiveState.scheduled.items[index].state != "off" else { throw BackendError.refused("This is switched off in its Settings.") }
        proactiveState.scheduled.items[index].state = paused ? "paused" : "active"
        proactiveState.scheduled.upcoming = ScheduledOverview.upcomingOf(proactiveState.scheduled.items)
        return proactiveState.scheduled.items[index].state
    }

    public func runScheduledNow(id: String) async throws {
        guard proactiveState.scheduled.items.contains(where: { $0.id == id }) else { throw BackendError.notFound }
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

    static let scheduledItems: [ScheduledJob] = [
        ScheduledJob(id: "auto_1", title: "Pay the electricity bill", summary: "Checks the bill and asks before paying.", state: "active", nextRunAt: Date(timeIntervalSince1970: 1_900_100_000)),
        ScheduledJob(id: "auto_2", title: "Daily brief", state: "active", isRoutine: true, nextRunAt: Date(timeIntervalSince1970: 1_900_200_000), confirmsRunNow: false),
        ScheduledJob(id: "auto_3", title: "Weekly expense review", summary: "Sorts the week's receipts.", state: "paused", nextRunAt: nil),
        ScheduledJob(id: "auto_4", title: "Mail digest", state: "off", isRoutine: true, confirmsRunNow: false),
    ]

    static let scheduledOverview = ScheduledOverview(
        upcoming: ScheduledOverview.upcomingOf(scheduledItems), items: scheduledItems,
        runs: [
            ScheduledRunItem(id: "run_1", title: "Daily brief", state: .succeeded, startedAt: Date(timeIntervalSince1970: 1_899_900_000), summary: "Sent."),
            ScheduledRunItem(id: "run_2", title: "Pay the electricity bill", state: .running, startedAt: Date(timeIntervalSince1970: 1_899_950_000), retryAt: Date(timeIntervalSince1970: 1_900_000_300)),
        ])
}
