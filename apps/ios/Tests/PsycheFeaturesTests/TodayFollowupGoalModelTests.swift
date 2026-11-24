import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct TodayFollowupGoalModelTests {
    // MARK: Today follow-ups

    @Test func doneRemovesTheRowFromTodayInPlace() async {
        let model = HomeModel(store: FixtureBackend())
        await model.load()
        let before = model.phase.value?.today ?? []
        #expect(before.count == 3)
        await model.actOnFollowup(before[0], .done)
        let after = model.phase.value?.today.map(\.id) ?? []
        #expect(after == before.dropFirst().map(\.id))
        #expect(model.notice == nil)
    }

    @Test func snoozeAndDismissAlsoLeaveToday() async {
        let store = FixtureBackend()
        let model = HomeModel(store: store)
        await model.load()
        let before = model.phase.value?.today ?? []
        await model.actOnFollowup(before[0], .snooze, until: nil)
        await model.actOnFollowup(before[1], .dismiss)
        #expect(model.phase.value?.today.map(\.id) == [before[2].id])
        #expect(model.followupsBusy.isEmpty)
    }

    @Test func aRefusedFollowupKeepsTheRowAndShowsTheGatewaysWords() async {
        let model = HomeModel(store: FixtureBackend())
        await model.load()
        let before = model.phase.value?.today ?? []
        // Not on Today any more: the fixture refuses it as the Gateway does for an id that is gone.
        let ghost = BriefItem(id: "gone", text: "Gone", evidenceLabel: "Because", evidence: [])
        await model.actOnFollowup(ghost, .done)
        #expect(model.phase.value?.today == before)
        #expect(model.notice == BackendError.notFound.errorDescription)
    }

    // MARK: Goal suggestions

    @Test func aSuggestionIsOfferedAndStartAcceptsIt() async {
        let store = FixtureBackend()
        let model = GoalsModel(store: store)
        await model.load()
        let goal = model.phase.value![0]
        await model.runSuggest(for: goal)
        guard case .offered(let idea) = model.suggest else {
            Issue.record("Expected an offered idea, got \(model.suggest)")
            return
        }
        #expect(idea.id == "idea_next_\(goal.id)")
        await model.decideSuggestion(start: true)
        #expect(model.suggest == .idle)
        let ideas = (try? await store.ideas()) ?? []
        #expect(!ideas.contains { $0.id == idea.id })
    }

    @Test func notNowDismissesTheSuggestionAndClearsTheCard() async {
        let store = FixtureBackend()
        let model = GoalsModel(store: store)
        await model.load()
        let goal = model.phase.value![0]
        await model.runSuggest(for: goal)
        await model.decideSuggestion(start: false)
        #expect(model.suggest == .idle)
        let ideas = (try? await store.ideas()) ?? []
        #expect(!ideas.contains { $0.id == "idea_next_\(goal.id)" })
    }

    @Test func aFailedSuggestionSaysWhy() async {
        let model = GoalsModel(store: FixtureBackend())
        let ghost = GoalItem(id: "gone", title: "Gone", category: "other", status: "active")
        await model.runSuggest(for: ghost)
        #expect(model.suggest == .failed(BackendError.notFound.errorDescription ?? ""))
    }

    @Test func cancellingASuggestionChangesNothing() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let goal = model.phase.value![0]
        model.startSuggest(for: goal)
        model.cancelSuggest()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(model.suggest == .idle)
    }

    // MARK: Goal links

    @Test func linkingATaskOrAutomationShowsItAndUnlinkRemovesIt() async throws {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let goal = model.phase.value![0]
        await model.open(goal)
        try await model.link(.automation("auto_2"), to: goal)
        #expect(model.detail.value?.links.contains(.automation("auto_2")) == true)
        await model.unlink(.task("task_q3"), from: goal)
        #expect(model.detail.value?.links.contains(.task("task_q3")) == false)
        #expect(model.actionError == nil)
    }

    @Test func thePickerLeavesOutWhatTheGoalAlreadyLinks() async {
        let model = GoalsModel(store: FixtureBackend())
        await model.load()
        let goal = model.phase.value![0]
        await model.open(goal)
        let choices = await model.linkChoices()
        #expect(!choices.tasks.contains { $0.target == .task("task_q3") })
        #expect(!choices.automations.contains { $0.target == .automation("auto_1") })
        #expect(choices.automations.contains { $0.target == .automation("auto_2") })
        #expect(model.linkTitles["auto_2"] != nil)
    }

    @Test func linkingToAGoneGoalThrowsSoThePickerCanSayWhy() async {
        let model = GoalsModel(store: FixtureBackend())
        let ghost = GoalItem(id: "gone", title: "Gone", category: "other", status: "active")
        await #expect(throws: BackendError.notFound) {
            try await model.link(.task("task_q3"), to: ghost)
        }
    }
}
