import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// The review screen's rules (docs/design/night-shift-2026.md §3.2, §5.2): what can be ticked, what Select all does to
/// sends, when a send box opens, and what the screen does when the answer path refuses.
@MainActor
struct NightShiftReviewTests {
    static func draft(
        _ id: String, truncated: Bool = false, fullBody: String? = "the whole draft", send: Bool = true,
        status: NightShiftItemStatus = .ready, needsMac: Bool = false
    ) -> NightShiftItem {
        NightShiftItem(
            id: id, domain: .mail, status: status, summary: "Reply \(id)", bindingHash: "h-\(id)", truncated: truncated,
            body: "the start", fullBody: fullBody,
            send: send ? NightShiftSend(recipients: ["a@x.example"], contentHash: "c-\(id)") : nil, needsMac: needsMac)
    }

    // MARK: 3. Select all never ticks a send; a truncated draft must be opened first

    @Test func selectAllTicksItemsButNeverASend() {
        let items = [Self.draft("a"), Self.draft("b"), Self.draft("c", send: false)]
        var selection = NightShiftSelection()
        selection.selectAll(items)
        #expect(selection.ticked == ["a", "b", "c"])
        #expect(selection.sendTicked.isEmpty)
        let request = selection.request(reviewID: "n1", items: items)
        #expect(request.items.map(\.itemID) == ["a", "b", "c"])
        #expect(request.sends.isEmpty)
    }

    @Test func selectAllLeavesASendTheOwnerTickedAloneAndAddsNone() {
        let items = [Self.draft("a"), Self.draft("b")]
        var selection = NightShiftSelection()
        selection.toggle(items[0])
        selection.toggleSend(items[0])
        selection.selectAll(items)
        #expect(selection.sendTicked == ["a"])
        #expect(selection.request(reviewID: "n1", items: items).sends == [NightShiftTick(itemID: "a", hash: "c-a")])
    }

    @Test func aSendIsOffByDefaultAndNeedsItsDraftTicked() {
        let item = Self.draft("a")
        var selection = NightShiftSelection()
        #expect(!selection.sendTicked.contains("a"))
        #expect(!selection.canTickSend(item))
        selection.toggleSend(item)
        #expect(selection.sendTicked.isEmpty)
        selection.toggle(item)
        #expect(selection.canTickSend(item))
        selection.toggleSend(item)
        #expect(selection.sendTicked == ["a"])
        // Unticking the draft takes its send with it.
        selection.toggle(item)
        #expect(selection.sendTicked.isEmpty)
        #expect(selection.request(reviewID: "n1", items: [item]).items.isEmpty)
    }

    @Test func aTruncatedPreviewKeepsTheSendOffUntilTheFullTextIsOpened() {
        let item = Self.draft("a", truncated: true)
        var selection = NightShiftSelection()
        selection.toggle(item)
        #expect(!selection.canTickSend(item))
        selection.toggleSend(item)
        #expect(selection.sendTicked.isEmpty)
        selection.expand(item)
        #expect(selection.canTickSend(item))
        selection.toggleSend(item)
        #expect(selection.sendTicked == ["a"])
        // Positive control: the same draft with an uncut preview needs no expanding.
        let whole = Self.draft("b")
        selection.toggle(whole)
        #expect(selection.canTickSend(whole))
    }

    @Test func aTruncatedDraftWithoutItsFullTextCanNeverBeSent() {
        let item = Self.draft("a", truncated: true, fullBody: nil)
        var selection = NightShiftSelection()
        selection.toggle(item)
        selection.expand(item)
        #expect(!selection.canTickSend(item))
        selection.toggleSend(item)
        #expect(selection.sendTicked.isEmpty)
    }

    // MARK: 5. Stale and refused items can't be ticked

    @Test(arguments: [NightShiftItemStatus.stale, .superseded, .applied, .failed, .uncertain, .skipped, .dismissed, .expired, .undone])
    func onlyAReadyItemCanBeTicked(_ status: NightShiftItemStatus) {
        let item = Self.draft("a", status: status)
        var selection = NightShiftSelection()
        selection.toggle(item)
        selection.selectAll([item])
        #expect(selection.ticked.isEmpty)
        #expect(!selection.canTick(item))
        #expect(selection.request(reviewID: "n1", items: [item]).isEmpty)
        // Positive control: the same item, ready, ticks.
        var ready = Self.draft("a")
        ready.status = .ready
        selection.toggle(ready)
        #expect(selection.ticked == ["a"])
    }

    @Test func anItemTheGatewayRefusedCannotBeTickedAgain() {
        let item = Self.draft("a")
        var selection = NightShiftSelection()
        selection.toggle(item)
        selection.toggleSend(item)
        selection.markRefused([NightShiftRefusal(itemID: "a", reason: "Changed.")])
        #expect(selection.ticked.isEmpty && selection.sendTicked.isEmpty)
        selection.toggle(item)
        selection.selectAll([item])
        #expect(selection.ticked.isEmpty)
        #expect(selection.refused["a"] == "Changed.")
    }

    @Test func anItemThatWentStaleInAFreshReadLosesItsTick() {
        let item = Self.draft("a")
        var selection = NightShiftSelection()
        selection.toggle(item)
        var stale = item
        stale.status = .stale
        selection.reconcile(with: [stale])
        #expect(selection.ticked.isEmpty)
        selection.reconcile(with: [])
        #expect(selection.expanded.isEmpty)
    }

    // MARK: 7. Items that need the Mac

    @Test func anItemThatNeedsTheMacCannotBeTicked() {
        let item = Self.draft("a", needsMac: true)
        var selection = NightShiftSelection()
        selection.toggle(item)
        selection.selectAll([item])
        #expect(selection.ticked.isEmpty)
        #expect(!item.canTick)
    }

    // MARK: The screen over the fixture backend

    @Test func theFixtureReviewMarksStaleAndOffersTheNewRecipientAndReplyAllDrafts() async {
        let model = NightShiftReviewModel(reviewID: FixtureData.nightShiftReviewID, store: FixtureBackend())
        await model.load()
        let stale = model.items.filter { $0.status == .stale }
        #expect(stale.map(\.id) == ["ns_cal_stale"])
        model.selectAll()
        #expect(!model.selection.ticked.contains("ns_cal_stale"))
        #expect(model.selection.sendTicked.isEmpty)
        let team = model.items.first { $0.id == "ns_mail_team" }
        #expect(team?.newRecipient == true && team?.replyAll == true && team?.truncated == true)
        // The cut-short draft's send box stays off until its whole text is opened.
        if let team {
            #expect(!model.selection.canTickSend(team))
            model.expand(team)
            #expect(model.selection.canTickSend(team))
        }
    }

    @Test func applyingFromTheFixtureSendsOnlyTheTickedHashesAndNoSendByDefault() async {
        let store = FixtureBackend()
        let model = NightShiftReviewModel(reviewID: FixtureData.nightShiftReviewID, store: store)
        await model.load()
        model.selectAll()
        await model.apply()
        let applied = await store.nightShiftState.applied
        #expect(applied.count == 1)
        #expect(applied[0].sends.isEmpty)
        #expect(!applied[0].items.contains { $0.itemID == "ns_cal_stale" })
        #expect(applied[0].items.allSatisfy { $0.hash.hasPrefix("sha256:") })
        if case .applying(let count) = model.banner { #expect(count == applied[0].items.count) } else { Issue.record("no banner") }
        #expect(model.selection.ticked.isEmpty)
    }

    @Test func aMismatchedApprovalShowsAnErrorAndAppliesNothing() async {
        let model = NightShiftReviewModel(reviewID: FixtureData.nightShiftReviewID, store: Refusing(error: NightShiftApplyError.mismatch))
        await model.load()
        model.selectAll()
        await model.apply()
        #expect(model.banner == .mismatch)
    }

    @Test func aMacOnlyApprovalShowsTheMacNoteAndKeepsTheTicks() async {
        let model = NightShiftReviewModel(reviewID: FixtureData.nightShiftReviewID, store: Refusing(outcome: .needsMac(refused: [])))
        await model.load()
        model.selectAll()
        await model.apply()
        #expect(model.banner == .needsMac)
        #expect(!model.selection.ticked.isEmpty)
    }

    @Test func dismissingTheRestRunsNothingAndEmptiesTheReadyList() async {
        let store = FixtureBackend()
        let model = NightShiftReviewModel(reviewID: FixtureData.nightShiftReviewID, store: store)
        await model.load()
        await model.dismissRest()
        #expect(!model.canDismissRest)
        #expect(await store.nightShiftState.applied.isEmpty)
    }
}

/// A backend whose apply refuses or hands off, over the fixture review. Everything else is the fixture's.
private struct Refusing: NightShiftBackend, LiveUpdates {
    func events() -> AsyncStream<LiveEvent> { base.events() }
    var error: (any Error)?
    var outcome: NightShiftApplyOutcome = .answered(refused: [])
    private let base = FixtureBackend()

    init(error: any Error) { self.error = error }
    init(outcome: NightShiftApplyOutcome) { self.outcome = outcome }

    func nightShiftStatus() async throws -> NightShiftStatus { try await base.nightShiftStatus() }
    func nightShiftReview(id: String) async throws -> NightShiftReview { try await base.nightShiftReview(id: id) }
    func applyNightShift(_ request: NightShiftApplyRequest) async throws -> NightShiftApplyOutcome {
        if let error { throw error }
        return outcome
    }
    func dismissNightShift(reviewID: String, itemIDs: [String]?) async throws {}
}
