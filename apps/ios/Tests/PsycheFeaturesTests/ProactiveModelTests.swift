import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct ProactiveModelTests {
    @Test func scheduledLoadsUpcomingAndRuns() async {
        let model = ScheduledModel(store: FixtureBackend())
        await model.load()
        #expect(model.phase.value?.upcoming.count == 2)
        #expect(model.phase.value?.runs.contains { $0.retryAt != nil } == true)
    }

    @Test func pastHoldsTheFinishedTasksThatTaskHistoryUsedToShow() async {
        let backend = FixtureBackend()
        let model = ScheduledModel(store: backend)
        #expect(model.past.isEmpty)
        await model.load()
        let recent = (try? await backend.activity().recent) ?? []
        #expect(!recent.isEmpty)
        #expect(model.past.map(\.id) == recent.map(\.id))
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

    // MARK: Freshness

    /// Waits (briefly) for a condition a debounced reload will make true.
    private func eventually(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<200 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
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
}
