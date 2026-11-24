import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct FollowupsModelTests {
    @Test func loadsTwoFollowUpsAndTwoSuggestions() async {
        let model = FollowupsModel(store: FixtureBackend())
        await model.load()
        #expect(model.followups.map(\.id) == ["mf_dana", "mf_lee"])
        #expect(model.suggestions.map(\.id) == ["sg_receipts", "sg_newsletters"])
    }

    @Test func snoozeAndDismissTakeTheThreadOff() async {
        let model = FollowupsModel(store: FixtureBackend())
        await model.load()
        await model.act(on: model.followups[0], .snooze)
        #expect(model.followups.map(\.id) == ["mf_lee"])
        await model.act(on: model.followups[0], .dismiss)
        #expect(model.followups.isEmpty)
        #expect(model.error == nil)
    }

    @Test func approveRunsTheSuggestionAndOffersUndoOnce() async {
        let store = FixtureBackend()
        let model = FollowupsModel(store: store)
        await model.load()
        await model.approve(model.suggestions[0])
        #expect(!model.suggestions.contains { $0.id == "sg_receipts" })
        #expect(model.openUndo(at: .now).map(\.id) == ["sg_receipts"])

        await model.undo(model.openUndo(at: .now)[0])
        #expect(model.openUndo(at: .now).isEmpty)
        // The inverse comes back as a suggestion waiting for its own approval.
        #expect(model.suggestions.contains { $0.id == "undo_sg_receipts" && $0.status == .pending })
        #expect(model.error == nil)
    }

    @Test func undoWindowCloses() async {
        let model = FollowupsModel(store: FixtureBackend())
        await model.load()
        await model.approve(model.suggestions[0])
        #expect(model.openUndo(at: .now.addingTimeInterval(FollowupsModel.undoWindow + 1)).isEmpty)
    }

    @Test func dismissRemovesTheSuggestion() async {
        let model = FollowupsModel(store: FixtureBackend())
        await model.load()
        await model.dismiss(model.suggestions[1])
        #expect(model.suggestions.map(\.id) == ["sg_receipts"])
    }

    @Test func aRefusalShowsTheGatewayWordsAndKeepsTheList() async {
        let store = FixtureBackend()
        let model = FollowupsModel(store: store)
        await model.load()
        let stale = model.suggestions[0]
        // Someone else finishes it first: the owner's tap now gets the Gateway's refusal.
        try? await store.approveSuggestion(id: stale.id)
        await model.approve(stale)
        #expect(model.error == "That suggestion is no longer waiting.")
        #expect(model.suggestions.contains { $0.id == stale.id } == false)
    }
}
