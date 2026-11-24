import Foundation

/// Feed, Ideas, Goals and Scheduled fixtures. Acting on a card or idea removes it, as the Gateway does.
struct ProactiveState: Sendable {
    var cards = FixtureData.feedCards
    var ideas = FixtureData.ideaItems
    var goals = FixtureData.goalDetails
    var scheduled = FixtureData.scheduledOverview
    /// Automations the editor created or changed; a seeded item without one reads back as a daily cron.
    var automations: [AutomationDetail] = []
    /// Past runs by automation id, newest first.
    var automationRuns: [String: [AutomationRunItem]] = FixtureData.automationRuns
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
        // goals.list leaves out archived goals, as the Gateway does.
        return proactiveState.goals.filter { $0.goal.status != "archived" }.map(\.goal)
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

    public func decideGoal(id: String, _ decision: GoalDecision) async throws -> GoalItem {
        await pause()
        guard let index = proactiveState.goals.firstIndex(where: { $0.goal.id == id }) else { throw BackendError.notFound }
        guard proactiveState.goals[index].goal.status == "candidate" else { throw BackendError.refused("This goal is already decided.") }
        switch decision {
        case .confirm: proactiveState.goals[index].goal.status = "active"
        case .reject: proactiveState.goals[index].goal.status = "archived"
        case .later: break
        }
        return proactiveState.goals[index].goal
    }

    public func archiveGoal(id: String) async throws -> GoalItem {
        await pause()
        guard let index = proactiveState.goals.firstIndex(where: { $0.goal.id == id }) else { throw BackendError.notFound }
        proactiveState.goals[index].goal.status = "archived"
        proactiveState.goals[index].goal.nextCheckinAt = nil
        return proactiveState.goals[index].goal
    }

    public func changeMilestone(goalID: String, _ change: GoalMilestoneChange) async throws -> GoalDetail {
        await pause()
        guard let index = proactiveState.goals.firstIndex(where: { $0.goal.id == goalID }) else { throw BackendError.notFound }
        switch change {
        case .add(let title, let dueAt):
            proactiveState.goals[index].milestones.append(
                GoalMilestoneItem(id: "m_\(UUID().uuidString.prefix(8))", title: title.trimmingCharacters(in: .whitespacesAndNewlines), dueAt: dueAt, done: false))
        case .setDone(let id, let done):
            guard let milestone = proactiveState.goals[index].milestones.firstIndex(where: { $0.id == id }) else { throw BackendError.notFound }
            proactiveState.goals[index].milestones[milestone].done = done
        case .remove(let id):
            guard proactiveState.goals[index].milestones.contains(where: { $0.id == id }) else { throw BackendError.notFound }
            proactiveState.goals[index].milestones.removeAll { $0.id == id }
        }
        return proactiveState.goals[index]
    }

    public func suggestNextStep(goalID: String) async throws -> String? {
        await pause()
        guard let goal = proactiveState.goals.first(where: { $0.goal.id == goalID }) else { throw BackendError.notFound }
        let idea = IdeaItem(
            id: "idea_next_\(goalID)", kind: "task", title: "Next step for \(goal.goal.title)",
            body: "One concrete step this week, from the goal's open milestones.", effort: "10 min")
        proactiveState.ideas.removeAll { $0.id == idea.id }
        proactiveState.ideas.insert(idea, at: 0)
        return idea.id
    }

    public func linkGoal(goalID: String, _ target: GoalLinkTarget) async throws {
        await pause()
        guard let index = proactiveState.goals.firstIndex(where: { $0.goal.id == goalID }) else { throw BackendError.notFound }
        guard !proactiveState.goals[index].links.contains(target) else { return }
        proactiveState.goals[index].links.append(target)
        proactiveState.goals[index].linkedTasks = proactiveState.goals[index].links.count
    }

    public func unlinkGoal(goalID: String, _ target: GoalLinkTarget) async throws {
        await pause()
        guard let index = proactiveState.goals.firstIndex(where: { $0.goal.id == goalID }) else { throw BackendError.notFound }
        proactiveState.goals[index].links.removeAll { $0 == target }
        proactiveState.goals[index].linkedTasks = proactiveState.goals[index].links.count
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

    public func automationRuns(id: String, cursor: String?) async throws -> AutomationRunPage {
        await pause()
        // Three rows a page, so the seven runs of auto_1 take three pages. The cursor is the offset of the next row.
        let rows = proactiveState.automationRuns[id] ?? []
        let start = cursor.flatMap { Int($0) } ?? 0
        guard start >= 0, start <= rows.count else { throw BackendError.refused("bad cursor") }
        let end = min(start + 3, rows.count)
        return AutomationRunPage(runs: Array(rows[start..<end]), nextCursor: end < rows.count ? String(end) : nil)
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
            ], linkedTasks: 2, links: [.task("task_q3"), .automation("auto_1")]),
        GoalDetail(goal: GoalItem(id: "goal_2", title: "Save for a deposit", category: "finance", status: "candidate")),
    ]

    static let scheduledItems: [ScheduledJob] = [
        ScheduledJob(id: "auto_1", title: "Pay the electricity bill", summary: "Checks the bill and asks before paying.", state: "active", nextRunAt: Date(timeIntervalSince1970: 1_900_100_000)),
        ScheduledJob(id: "auto_2", title: "Daily brief", state: "active", isRoutine: true, nextRunAt: Date(timeIntervalSince1970: 1_900_200_000), confirmsRunNow: false),
        ScheduledJob(id: "auto_3", title: "Weekly expense review", summary: "Sorts the week's receipts.", state: "paused", nextRunAt: nil),
        ScheduledJob(id: "auto_4", title: "Mail digest", state: "off", isRoutine: true, confirmsRunNow: false),
    ]

    /// Seven runs of "Pay the electricity bill" (auto_1), newest first: one running, one done with a task, one
    /// failed with its reason, one with no reply, one failed after retries, one done with no task.
    static let automationRuns: [String: [AutomationRunItem]] = [
        "auto_1": [
            AutomationRunItem(id: "arun_7", status: .running, startedAt: Date(timeIntervalSince1970: 1_900_300_000), taskID: "task_q3"),
            AutomationRunItem(
                id: "arun_6", status: .done, startedAt: Date(timeIntervalSince1970: 1_900_200_000),
                endedAt: Date(timeIntervalSince1970: 1_900_200_095), summary: "Checked the bill: nothing due yet.", taskID: "task_q3"),
            AutomationRunItem(
                id: "arun_5", status: .failed, startedAt: Date(timeIntervalSince1970: 1_900_100_000),
                endedAt: Date(timeIntervalSince1970: 1_900_100_040),
                summary: "The utility site timed out twice, so nothing was paid.", taskID: "task_invoice"),
            AutomationRunItem(
                id: "arun_4", status: .done, startedAt: Date(timeIntervalSince1970: 1_900_000_000),
                endedAt: Date(timeIntervalSince1970: 1_900_000_060), summary: "Paid nothing: the bill was already settled."),
            AutomationRunItem(
                id: "arun_3", status: .noReply, startedAt: Date(timeIntervalSince1970: 1_899_900_000),
                endedAt: Date(timeIntervalSince1970: 1_899_900_012)),
            AutomationRunItem(
                id: "arun_2", status: .failed, startedAt: Date(timeIntervalSince1970: 1_899_800_000),
                endedAt: Date(timeIntervalSince1970: 1_899_800_005), summary: "The model was unavailable after three tries."),
            AutomationRunItem(
                id: "arun_1", status: .done, startedAt: Date(timeIntervalSince1970: 1_899_700_000),
                endedAt: Date(timeIntervalSince1970: 1_899_700_150), summary: "Checked the bill."),
        ]
    ]

    static let scheduledOverview = ScheduledOverview(
        upcoming: ScheduledOverview.upcomingOf(scheduledItems), items: scheduledItems,
        runs: [
            ScheduledRunItem(id: "run_1", title: "Daily brief", state: .succeeded, startedAt: Date(timeIntervalSince1970: 1_899_900_000), summary: "Sent."),
            ScheduledRunItem(id: "run_2", title: "Pay the electricity bill", state: .running, startedAt: Date(timeIntervalSince1970: 1_899_950_000), retryAt: Date(timeIntervalSince1970: 1_900_000_300)),
        ])
}
