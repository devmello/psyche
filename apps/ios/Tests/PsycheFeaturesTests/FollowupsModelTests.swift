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

    @Test func undoAppearsEvenWhenTheBatchIsStillRunningRightAfterTheAnswer() async {
        let store = FixtureBackend()
        await store.setFollowupRunReads(3)
        let model = FollowupsModel(store: store, settleDelay: .milliseconds(1), settleAttempts: 8)
        await model.load()
        await model.approve(model.suggestions[0])
        // The first reads see `running`; the model waits instead of dropping Undo.
        #expect(model.openUndo(at: .now).map(\.id) == ["sg_receipts"])
        #expect(model.openUndo(at: .now)[0].suggestion.status == .done)
    }

    @Test func waitingForTheBatchIsBounded() async {
        let store = FixtureBackend()
        await store.setFollowupRunReads(100)
        let model = FollowupsModel(store: store, settleDelay: .milliseconds(1), settleAttempts: 3)
        await model.load()
        await model.approve(model.suggestions[0])
        // Still running after the bound: no Undo is offered, and nothing hangs.
        #expect(model.openUndo(at: .now).isEmpty)
        #expect(model.error == nil)
    }

    @Test func aSecondUndoIsRefusedAndTheOriginalOffersNone() async {
        let store = FixtureBackend()
        let model = FollowupsModel(store: store)
        await model.load()
        await model.approve(model.suggestions[0])
        let window = model.openUndo(at: .now)[0]
        await model.undo(window)
        #expect(model.openUndo(at: .now).isEmpty)
        // A stale second tap on the same window is refused: the original reads as undone.
        await model.undo(window)
        #expect(model.error == "This can't be undone any more.")
        #expect(model.suggestions.filter { $0.id == "undo_sg_receipts" }.count == 1)
    }

    @Test func approvingABatchAwaitingApprovalHandsOverItsExistingApproval() async throws {
        let store = FixtureBackend()
        let model = FollowupsModel(store: store)
        await model.load()
        try await store.awaitApproval("sg_receipts")
        await model.load()
        let handoff = await model.approve(model.suggestions[0])
        #expect(handoff?.kind == .approval)
        #expect(model.error == nil)
        // It stays on the list until that approval is answered: nothing ran.
        #expect(model.openUndo(at: .now).isEmpty)
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
