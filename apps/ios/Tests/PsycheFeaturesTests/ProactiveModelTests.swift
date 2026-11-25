import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct ProactiveModelTests {
    @Test func routesMapToTheNewPages() {
        #expect(Route(appPath: "/feed") == .feed)
        #expect(Route(appPath: "/ideas") == .ideas)
        #expect(Route(appPath: "/goals") == .goals)
        #expect(Route(appPath: "/goals/g1") == .project(id: "g1"))
    }

    @Test func notInterestedTakesTheCardOffAndSaveKeepsItMarked() async {
        let model = FeedModel(store: FixtureBackend())
        await model.load()
        let cards = model.phase.value?.cards ?? []
        #expect(cards.count == 2)

        await model.give(.save, to: cards[0])
        #expect(model.phase.value?.cards[0].feedback == .save)
        // A second tap on the same mark clears it.
        await model.give(.save, to: model.phase.value!.cards[0])
        #expect(model.phase.value?.cards[0].feedback == nil)

        await model.give(.notInterested, to: cards[1])
        #expect(model.phase.value?.cards.map(\.id) == [cards[0].id])
        await model.load()
        #expect(model.phase.value?.cards.map(\.id) == [cards[0].id])
    }

    @Test func makingTodaysBriefReloadsTheFeedAndClearsProgress() async {
        let model = FeedModel(store: FixtureBackend())
        await model.generate()
        #expect(model.generating == false)
        #expect(model.actionError == nil)
        #expect(model.phase.value?.cards.isEmpty == false)
    }

    @Test func acceptingOrDismissingAnIdeaRemovesIt() async {
        let model = IdeasModel(store: FixtureBackend())
        await model.load()
        let ideas = model.phase.value ?? []
        await model.accept(ideas[0])
        #expect(model.phase.value?.map(\.id) == [ideas[1].id])
        await model.dismiss(ideas[1], reason: .notNow)
        #expect(model.phase.value?.isEmpty == true)
        #expect(model.actionError == nil)
    }

    @Test func aFailedDecisionPutsTheIdeaBackAndSaysWhy() async {
        let model = IdeasModel(store: FixtureBackend())
        await model.load()
        let before = model.phase.value
        // Not a real idea: the fixture refuses it, as the Gateway does for an id that is gone.
        let ghost = IdeaItem(id: "gone", kind: "task", title: "Gone", body: "")
        await model.accept(ghost)
        #expect(model.phase.value == before)
        #expect(model.actionError != nil)
    }

    @Test func goalDetailLoadsOnOpenAndClears() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let goal = model.phase.value![0]
        await model.open(goal)
        #expect(model.detail.value?.milestones.count == 3)
        #expect(model.detail.value?.progress == 1.0 / 3.0)
        model.close()
        #expect(model.detail.value == nil)
    }

    @Test func scheduledLoadsUpcomingAndRuns() async {
        let model = ScheduledModel(store: FixtureBackend())
        await model.load()
        #expect(model.phase.value?.upcoming.count == 2)
        #expect(model.phase.value?.runs.contains { $0.retryAt != nil } == true)
    }

    // MARK: Words

    @Test func aRunWaitingOnItsNextAttemptReadsRetryingAt() {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let retry = now.addingTimeInterval(300)
        let waiting = ScheduledRunItem(id: "r", title: "t", state: .running, retryAt: retry)
        #expect(ProactiveText.runLine(waiting, now: now).contains(ProactiveText.time(retry)))
        #expect(ProactiveText.runLine(waiting, now: now) != ProactiveText.runState(.running))
        // A retry time already past: the attempt is under way, so it is plain Running.
        let past = ScheduledRunItem(id: "r", title: "t", state: .running, retryAt: now.addingTimeInterval(-60))
        #expect(ProactiveText.runLine(past, now: now) == ProactiveText.runState(.running))
        // Only a running run retries.
        let failed = ScheduledRunItem(id: "r", title: "t", state: .failed, retryAt: retry)
        #expect(ProactiveText.runLine(failed, now: now) == ProactiveText.runState(.failed))
    }

    @Test func everyRunStateHasWordsAndAUniqueEnoughDot() {
        for state in [ScheduledRunState.running, .waiting, .succeeded, .notVerified, .failed, .skipped, .cancelled] {
            #expect(!ProactiveText.runState(state).isEmpty)
        }
        #expect(ProactiveText.runDot(.waiting) == .needsYou)
        #expect(ProactiveText.runDot(.succeeded) == .done)
        #expect(ProactiveText.runDot(.failed) == .failed)
    }

    @Test func pausingAScheduledItemChangesItsStateOnceTheGatewayAnswers() async {
        let model = ScheduledModel(store: FixtureBackend())
        await model.load()
        let job = model.phase.value!.items[0]
        #expect(job.state == "active")
        await model.togglePause(job)
        #expect(model.phase.value?.items.first { $0.id == job.id }?.state == "paused")
        #expect(model.phase.value?.upcoming.contains { $0.id == job.id } == false)
        #expect(model.actionError == nil && !model.isBusy(job.id))

        let paused = model.phase.value!.items.first { $0.id == job.id }!
        await model.togglePause(paused)
        #expect(model.phase.value?.items.first { $0.id == job.id }?.state == "active")
    }

    @Test func aFailedPauseSaysWhyAndLeavesTheStateAlone() async {
        let model = ScheduledModel(store: FixtureBackend())
        await model.load()
        let before = model.phase.value
        // Not an item the Gateway lists: the fixture refuses it as the Gateway does for an id that is gone.
        await model.togglePause(ScheduledJob(id: "gone", title: "Gone", state: "active"))
        #expect(model.phase.value == before)
        #expect(model.actionError != nil)
    }

    @Test func aRoutineThatIsOffHasNoPauseOrRunNow() async {
        let model = ScheduledModel(store: FixtureBackend())
        await model.load()
        let off = model.phase.value!.items.first { $0.state == "off" }!
        await model.togglePause(off)
        await model.runNow(off)
        #expect(model.phase.value?.items.first { $0.id == off.id }?.state == "off")
        #expect(model.actionError == nil)
    }

    @Test func runNowKeepsTheListAndSaysWhenItFails() async {
        let model = ScheduledModel(store: FixtureBackend())
        await model.load()
        let before = model.phase.value
        await model.runNow(model.phase.value!.items[0])
        #expect(model.actionError == nil)
        await model.runNow(ScheduledJob(id: "gone", title: "Gone", state: "active"))
        #expect(model.actionError != nil)
        #expect(model.phase.value?.items.count == before?.items.count)
    }

    @Test func goalStatusChoicesFollowTheGoal() {
        // A suggested goal is decided (confirm, later, reject), not set, so it has no status choices.
        #expect(GoalsModel.choices(for: "candidate").isEmpty)
        #expect(GoalsModel.choices(for: "active") == [.paused, .done])
        #expect(GoalsModel.choices(for: "paused") == [.active, .done])
        #expect(GoalsModel.choices(for: "done") == [.active])
        #expect(GoalsModel.choices(for: "archived").isEmpty)
    }

    @Test func confirmingASuggestedGoalMakesItActiveInTheList() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let suggested = model.phase.value!.first { $0.status == "candidate" }!
        await model.open(suggested)
        let closed = await model.decide(.confirm, for: suggested)
        #expect(closed == false)
        #expect(model.detail.value?.goal.status == "active")
        #expect(model.phase.value?.first { $0.id == suggested.id }?.status == "active")
        #expect(model.actionError == nil)
    }

    @Test func laterKeepsASuggestedGoalAndRejectTakesItOffTheList() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let suggested = model.phase.value!.first { $0.status == "candidate" }!
        await model.open(suggested)
        #expect(await model.decide(.later, for: suggested) == false)
        #expect(model.phase.value?.first { $0.id == suggested.id }?.status == "candidate")
        #expect(await model.decide(.reject, for: suggested) == true)
        #expect(model.phase.value?.contains { $0.id == suggested.id } == false)
        #expect(model.detail.value?.goal.status == "archived")
    }

    @Test func aDecisionTheGatewayRefusesKeepsTheGoalAndSaysWhy() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let active = model.phase.value!.first { $0.status == "active" }!
        let before = model.phase.value
        #expect(await model.decide(.confirm, for: active) == false)
        #expect(model.phase.value == before)
        #expect(model.actionError != nil)
    }

    @Test func archivingAGoalRemovesItFromTheListAndClosesTheSheet() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let goal = model.phase.value!.first { $0.id == "goal_1" }!
        await model.open(goal)
        #expect(await model.archive(goal) == true)
        #expect(model.phase.value?.contains { $0.id == goal.id } == false)
        #expect(model.detail.value?.goal.status == "archived")
    }

    @Test func milestonesAddMarkAndRemoveUpdateTheSheet() async throws {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let goal = model.phase.value!.first { $0.id == "goal_1" }!
        await model.open(goal)
        let before = model.detail.value?.milestones.count ?? -1

        await model.changeMilestone(.setDone(id: "m2", true), for: goal)
        #expect(model.detail.value?.milestones.first { $0.id == "m2" }?.done == true)

        try await model.addMilestone(title: "  Buy shoes  ", dueAt: nil, for: goal)
        #expect(model.detail.value?.milestones.count == before + 1)
        #expect(model.detail.value?.milestones.last?.title == "Buy shoes")

        let added = model.detail.value!.milestones.last!
        await model.changeMilestone(.remove(id: added.id), for: goal)
        #expect(model.detail.value?.milestones.count == before)
        #expect(model.actionError == nil)
    }

    @Test func aRefusedMilestoneEditKeepsTheListAndSaysWhy() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let goal = model.phase.value!.first { $0.id == "goal_1" }!
        await model.open(goal)
        let before = model.detail.value
        await model.changeMilestone(.remove(id: "gone"), for: goal)
        #expect(model.detail.value == before)
        #expect(model.actionError != nil)
    }

    @Test func settingAGoalStatusUpdatesTheListAndTheSheet() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let goal = model.phase.value![0]
        await model.open(goal)
        await model.setStatus(.paused, for: goal)
        #expect(model.detail.value?.goal.status == "paused")
        #expect(model.phase.value?.first { $0.id == goal.id }?.status == "paused")
        #expect(model.actionError == nil)
    }

    @Test func aRefusedGoalStatusKeepsTheGoalAndSaysWhy() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let before = model.phase.value
        await model.setStatus(.done, for: GoalItem(id: "gone", title: "Gone", category: "other", status: "active"))
        #expect(model.phase.value == before)
        #expect(model.actionError != nil)
    }

    @Test func aGoalDraftNeedsATitleOnceItIsTrimmed() {
        #expect(!GoalDraft().isValid)
        #expect(!GoalDraft(title: "   \n ").isValid)
        #expect(GoalDraft(title: " Run ").isValid)
        #expect(GoalDraft(title: " Run ").trimmedTitle == "Run")
        #expect(GoalDraft().category == .other)
    }

    @Test func creatingAGoalReloadsTheListAndABlankDraftCreatesNothing() async throws {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let before = model.phase.value?.count ?? -1
        try await model.create(GoalDraft(title: "  Learn Swift  ", category: .learning))
        #expect(model.phase.value?.count == before + 1)
        #expect(model.phase.value?.last?.title == "Learn Swift")
        #expect(model.phase.value?.last?.category == "learning")
        try await model.create(GoalDraft(title: " "))
        #expect(model.phase.value?.count == before + 1)
    }

    // MARK: Freshness

    /// Waits (briefly) for a condition a debounced reload will make true.
    private func eventually(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<200 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    @Test func aNotInterestedPostStaysGoneAfterEveryReload() async {
        let backend = FixtureBackend()
        let model = FeedModel(store: backend)
        await model.load()
        let gone = model.phase.value!.cards[1]
        await model.give(.notInterested, to: gone)
        await model.load()
        #expect(model.phase.value?.cards.contains { $0.id == gone.id } == false)
        // Another device's feedback, or a backend that still sends the post, changes nothing on screen.
        let fresh = FeedModel(store: backend)
        await fresh.load()
        #expect(fresh.phase.value?.cards.contains { $0.id == gone.id } == false)
        #expect(FeedCard(id: "x", title: "t", body: "", feedback: .notInterested).isDismissed)
        #expect(FeedCard(id: "x", title: "t", body: "", hiddenByFeedback: true).isDismissed)
        #expect(!FeedCard(id: "x", title: "t", body: "", feedback: .save).isDismissed)
    }

    @Test func theFeedReloadsWhenAPostArrivesAndOnResync() async {
        let backend = FixtureBackend()
        let model = FeedModel(store: backend, reloadDelay: .milliseconds(5))
        await model.load()
        let observing = Task { await model.observe() }
        defer { observing.cancel() }
        try? await Task.sleep(for: .milliseconds(50))
        // A post marked not interested elsewhere: the next reload drops nothing new, but a change event must reload.
        try? await backend.setFeedback(postID: "post_1", .notInterested)
        await backend.publish(.changed(.home))
        #expect(await eventually { model.phase.value?.cards.contains { $0.id == "post_1" } == false })

        try? await backend.setFeedback(postID: "post_2", .notInterested)
        await backend.publish(.resynced)
        #expect(await eventually { model.phase.value?.cards.isEmpty == true })
    }

    @Test func ideasAndGoalsReloadOnHomeChanges() async {
        let backend = FixtureBackend()
        let ideas = IdeasModel(store: backend, reloadDelay: .milliseconds(5))
        let goals = GoalsModel(store: backend, reloadDelay: .milliseconds(5))
        await ideas.load()
        await goals.load()
        let observeIdeas = Task { await ideas.observe() }
        let observeGoals = Task { await goals.observe() }
        defer { observeIdeas.cancel(); observeGoals.cancel() }
        try? await Task.sleep(for: .milliseconds(50))
        let firstIdea = ideas.phase.value![0]
        try? await backend.acceptIdea(id: firstIdea.id)
        let count = goals.phase.value!.count
        _ = try? await backend.createGoal(title: "New goal", category: .other)
        await backend.publish(.changed(.home))
        #expect(await eventually { ideas.phase.value?.contains { $0.id == firstIdea.id } == false })
        #expect(await eventually { goals.phase.value?.count == count + 1 })
    }

    @Test func aBurstOfEventsReloadsOnce() async {
        let backend = FixtureBackend()
        let model = FeedModel(store: backend, reloadDelay: .milliseconds(60))
        await model.load()
        let observing = Task { await model.observe() }
        defer { observing.cancel() }
        try? await Task.sleep(for: .milliseconds(50))
        try? await backend.setFeedback(postID: "post_1", .notInterested)
        for _ in 0..<5 { await backend.publish(.changed(.home)) }
        #expect(model.phase.value?.cards.contains { $0.id == "post_1" } == true, "still waiting out the delay")
        #expect(await eventually { model.phase.value?.cards.contains { $0.id == "post_1" } == false })
    }

    @Test func scheduledReloadsOnAutomationChangesAndResync() async {
        let backend = FixtureBackend()
        let model = ScheduledModel(store: backend, reloadDelay: .milliseconds(5))
        await model.load()
        let observing = Task { await model.observe() }
        defer { observing.cancel() }
        try? await Task.sleep(for: .milliseconds(50))
        let job = model.phase.value!.items.first { $0.state == "active" && !$0.isRoutine }!
        try? await backend.deleteAutomation(id: job.id)
        await backend.publish(.changed(.scheduled))
        #expect(await eventually { model.phase.value?.items.contains { $0.id == job.id } == false })
    }

    @Test func loadMoreAppendsOlderPostsAndIdeasUntilTheLastPage() async {
        let backend = FixtureBackend()
        await backend.setProactivePageSize(1)
        let feed = FeedModel(store: backend)
        await feed.load()
        #expect(feed.phase.value?.cards.count == 1 && feed.phase.value?.nextCursor != nil)
        await feed.loadOlder()
        #expect(feed.phase.value?.cards.count == 2 && feed.phase.value?.nextCursor == nil)
        await feed.loadOlder()
        #expect(feed.phase.value?.cards.count == 2)

        let ideas = IdeasModel(store: backend)
        await ideas.load()
        #expect(ideas.phase.value?.count == 1 && ideas.nextCursor != nil)
        await ideas.loadOlder()
        #expect(ideas.phase.value?.count == 2 && ideas.nextCursor == nil)
    }

    @Test func pausedAndDoneGoalsStayListedAndADoneGoalCanBeReopened() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let goal = model.phase.value![0]
        await model.setStatus(.done, for: goal)
        await model.load()
        #expect(model.phase.value?.first { $0.id == goal.id }?.status == "done")
        #expect(GoalsModel.choices(for: "done") == [.active])
        await model.setStatus(.active, for: goal)
        #expect(model.phase.value?.first { $0.id == goal.id }?.status == "active")
    }
}
