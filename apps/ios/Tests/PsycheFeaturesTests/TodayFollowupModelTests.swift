import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct TodayFollowupModelTests {
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
}
