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
}
