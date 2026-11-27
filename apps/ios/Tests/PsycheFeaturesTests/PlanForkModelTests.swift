import Foundation

import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// Fork a plan on the phone (docs/design/fork-a-plan-2026.md §5.2) over the fixture backend: what the Take sheet can tick
/// and sends, what the scrub count lines say, the start sheet's rules and the route a fork card opens.
@MainActor
struct PlanForkModelTests {
    let store = FixtureBackend()

    // MARK: The scrub count lines

    @Test func aScrubbedBranchSaysHowMuchStaysOnTheMac() async throws {
        let detail = try await store.planFork(id: FixtureData.scrubbedForkID)
        // Counts, not gaps: "4 more on your Mac" over both branches, and no total where a cost is withheld.
        #expect(detail.hiddenItems == 4)
        #expect(PlanForkText.moreOnMac(1).contains("1") && PlanForkText.moreOnMac(4).contains("4"))
        let out = try #require(detail.branch("fbr_near"))
        #expect(detail.totalLines(out) == [PlanForkText.totalOnMac])
        #expect(detail.textHidden)
        #expect(!PlanForkText.readOnMac.isEmpty)
        // Positive control: a branch with nothing withheld shows its computed totals and no count.
        let full = try await store.planFork(id: FixtureData.leaseForkID)
        let renew = try #require(full.branch(FixtureData.leaseRenewBranchID))
        #expect(full.hiddenItems == 0 && !full.textHidden && !renew.scrub.isScrubbed)
        #expect(full.totalLines(renew).count == 1 && full.totalLines(renew) != [PlanForkText.totalOnMac])
        #expect(full.totalLines(renew)[0].contains("2,190"))
    }

    @Test func aDayWithNoTimeIsShownAsThatDayWhateverTheTimeZone() {
        // 2030-03-01 is a calendar day: it must not read as Feb 28 for a viewer west of UTC.
        let zones = ["America/Los_Angeles", "Pacific/Auckland", "UTC"].compactMap { TimeZone(identifier: $0) }
        let lines = Set(zones.map { PlanForkText.date("2030-03-01", in: $0) })
        #expect(lines.count == 1 && lines.first?.contains("28") == false)
        // Positive control: a moment does move with the viewer's zone.
        let moments = Set(zones.map { PlanForkText.date("2030-03-01T02:00:00Z", in: $0) })
        #expect(moments.count > 1)
        #expect(PlanForkText.date("not a date") == "not a date")
    }

    @Test func totalsAreSummedPerCurrencyAndPeriodAndNeverConverted() {
        let report = PlanForkReport(costs: [
            PlanForkCost(id: "1", label: "Rent", amount: 100, currency: "USD", period: .month),
            PlanForkCost(id: "2", label: "Fee", amount: 20, currency: "USD", period: .month, estimate: true),
            PlanForkCost(id: "3", label: "Movers", amount: 500, currency: "USD", period: .once),
            PlanForkCost(id: "4", label: "Rent", amount: 90, currency: "EUR", period: .month),
        ])
        #expect(report.totals == [
            PlanForkTotal(currency: "EUR", period: .month, amount: 90, includesEstimate: false),
            PlanForkTotal(currency: "USD", period: .once, amount: 500, includesEstimate: false),
            PlanForkTotal(currency: "USD", period: .month, amount: 120, includesEstimate: true),
        ])
    }

    @Test func theCompareTabShowsDifferingRowsFirstAndAllRowsOnRequest() async throws {
        let detail = try await store.planFork(id: FixtureData.leaseForkID)
        let differing = detail.comparisonRows(showAll: false)
        let all = detail.comparisonRows(showAll: true)
        #expect(all.count == 5 && differing.count == 4)
        #expect(differing.allSatisfy(\.differs) && all.contains { !$0.differs })
        // A comparison cell names items the branch holds, and the lines come out in the cell's order.
        let row = try #require(all.first { $0.dimension == .cost })
        let renew = try #require(detail.branch(FixtureData.leaseRenewBranchID)?.report)
        #expect(renew.lines(.cost, ids: ["c2", "c1"]).map(\.id) == ["c2", "c1"])
        #expect(renew.lines(.cost, ids: ["missing"]).isEmpty)
        #expect(row.cells.count == 2)
    }

    // MARK: Take

    @Test func nothingIsTickedAtFirstAndASendNeverRidesAlong() async throws {
        let model = PlanForkTakeModel(forkID: FixtureData.leaseForkID, branchID: FixtureData.leaseRenewBranchID, store: store)
        await model.load()
        #expect(model.request.items.isEmpty && model.request.sends.isEmpty)
        #expect(model.continuePlan)
        let reply = try #require(model.loadedItems.first { $0.id == "fs_reply" })
        model.toggle(reply)
        #expect(model.request.items == [NightShiftTick(itemID: "fs_reply", hash: "sha256:fork-reply")])
        // Ticking an item does not tick its send. The send is its own tick, off until the owner reads the draft.
        #expect(model.request.sends.isEmpty)
        model.toggleSend(reply)
        #expect(model.request.sends.map(\.itemID) == ["fs_reply"])
        #expect(model.request.sends[0].recipients == ["sam@homes.example"])
    }

    @Test func anItemFromMessagesCannotBeTickedOnThePhone() async throws {
        let model = PlanForkTakeModel(forkID: FixtureData.leaseForkID, branchID: FixtureData.leaseRenewBranchID, store: store)
        await model.load()
        let withheld = try #require(model.loadedItems.first { $0.id == "fs_msg" })
        model.toggle(withheld)
        #expect(model.request.items.isEmpty && !model.selection.canTick(withheld))
    }

    @Test func takingWithTicksBindsTheHashesAndMarksTheForkTaken() async throws {
        let model = PlanForkTakeModel(forkID: FixtureData.leaseForkID, branchID: FixtureData.leaseRenewBranchID, store: store)
        await model.load()
        for id in ["fs_reply", "fs_rem"] { model.toggle(try #require(model.loadedItems.first { $0.id == id })) }
        await model.take()
        #expect(model.finished && model.banner == nil)
        let taken = await store.planForkState.taken
        #expect(taken.count == 1 && taken[0].items.map(\.hash) == ["sha256:fork-reply", "sha256:fork-rem"] && taken[0].continuePlan)
        let detail = try await store.planFork(id: FixtureData.leaseForkID)
        #expect(detail.fork.status == .taken && detail.fork.takenBranchID == FixtureData.leaseRenewBranchID)
        // The chat gets its "Plan taken" line.
        let thread = try await store.thread(id: "thr_lease")
        #expect(thread.items.contains { if case .planTaken = $0 { true } else { false } })
        // A taken fork can't be taken again, and its branches can't be taken from the phone any more.
        #expect(!detail.canTake(try #require(detail.branches.first)))
        await #expect(throws: BackendError.self) {
            _ = try await store.takePlanFork(PlanForkTakeRequest(forkID: FixtureData.leaseForkID, branchID: FixtureData.leaseRenewBranchID, items: [], sends: [], continuePlan: false))
        }
    }

    @Test func takingWithNothingTickedTakesThePlanOnItsSteps() async throws {
        let model = PlanForkTakeModel(forkID: FixtureData.leaseForkID, branchID: FixtureData.leaseMoveBranchID, store: store)
        model.continuePlan = false
        await model.load()
        #expect(model.loadedItems.isEmpty)
        await model.take()
        #expect(model.finished)
        #expect(await store.planForkState.taken.first?.continuePlan == false)
    }

    @Test func aStaleHashIsRefusedAndThePlanKeepsWaiting() async throws {
        // The fixture Gateway refuses an item whose hash moved, as the real one does: nothing is taken.
        let request = PlanForkTakeRequest(
            forkID: FixtureData.leaseForkID, branchID: FixtureData.leaseRenewBranchID,
            items: [NightShiftTick(itemID: "fs_rem", hash: "sha256:changed")], sends: [], continuePlan: true)
        let outcome = try await store.takePlanFork(request)
        guard case .nothingApproved(let refused) = outcome else { Issue.record("\(outcome)"); return }
        #expect(refused.map(\.itemID) == ["fs_rem"])
        #expect(try await store.planFork(id: FixtureData.leaseForkID).fork.status == .ready)
    }

    // MARK: Start

    @Test func theSheetNeedsTwoCompleteOptionsAndHoldsAtFour() async throws {
        let model = PlanForkStartModel(threadID: "thr_lease", messageID: "l2", store: store)
        #expect(!model.canStart && model.drafts.count == 2 && !model.canRemove(model.drafts[0]))
        let (a, b) = (model.drafts[0].id, model.drafts[1].id)
        model.edit(a, label: "  Renew  ", premise: "Assume you renew.")
        // Half an option does not count, and shows its warning only once edited.
        model.edit(b, label: "Move")
        #expect(!model.canStart && model.isIncomplete(model.drafts[1]) && !model.isIncomplete(model.drafts[0]))
        model.edit(b, premise: "Assume you move.")
        #expect(model.canStart)
        #expect(model.options == [PlanForkOption(label: "Renew", premise: "Assume you renew."), PlanForkOption(label: "Move", premise: "Assume you move.")])
        model.add(); model.add(); model.add()
        #expect(model.drafts.count == PlanForkOption.maxOptions && !model.canAdd)
        // An untouched extra row is left out, not sent blank.
        #expect(model.options.count == 2)
        model.remove(model.drafts[3].id)
        #expect(model.drafts.count == 3)
    }

    @Test func aNameAndAnAssumptionAreCutAtTheirLimits() {
        let model = PlanForkStartModel(threadID: "t", messageID: "m", store: store)
        let id = model.drafts[0].id
        model.edit(id, label: String(repeating: "a", count: 90), premise: String(repeating: "b", count: 400))
        #expect(model.drafts[0].label.count == PlanForkOption.labelLimit && model.drafts[0].premise.count == PlanForkOption.premiseLimit)
    }

    @Test func theSuggestionFillsAnEmptySheetButNeverOverwritesTyping() async throws {
        let model = PlanForkStartModel(threadID: "thr_lease", messageID: "l2", store: store)
        await model.suggest()
        #expect(model.drafts.count == 2 && model.canStart)
        let typed = PlanForkStartModel(threadID: "thr_lease", messageID: "l2", store: store)
        typed.edit(typed.drafts[0].id, label: "Mine")
        await typed.suggest()
        #expect(typed.drafts[0].label == "Mine" && typed.drafts[1].label.isEmpty)
    }

    @Test func startingMakesAForkThatFinishesAndASecondOneWaits() async throws {
        let model = PlanForkStartModel(threadID: "thr_lease", messageID: "l2", store: store)
        await model.suggest()
        await model.refreshEstimate()
        let estimate = try #require(model.estimate)
        #expect(PlanForkText.estimate(estimate).contains("0.40"))
        let started = try #require(await model.start())
        #expect(started.fork.status == .running && started.branches.allSatisfy { $0.status == .running })
        // The chat is already working one: a second start is refused in the Gateway's words, and it shows.
        let again = PlanForkStartModel(threadID: "thr_lease", messageID: "l2", store: store)
        await again.suggest()
        #expect(await again.start() == nil && again.error != nil)
        await store.finishPlanFork(id: started.fork.id)
        let done = try await store.planFork(id: started.fork.id)
        #expect(done.fork.status == .ready && done.canTake(done.branches[0]))
    }

    @Test func cancellingStopsEveryRunningBranchAndKeepsTheFork() async throws {
        let started = try await store.createPlanFork(
            threadID: "thr_trip", messageID: "t2",
            options: [PlanForkOption(label: "A", premise: "a"), PlanForkOption(label: "B", premise: "b")])
        try await store.cancelPlanFork(forkID: started.fork.id, branchID: nil)
        let after = try await store.planFork(id: started.fork.id)
        #expect(after.fork.status == .cancelled && after.branches.allSatisfy { $0.status == .cancelled })
    }

    // MARK: The route a card opens

    @Test func theForkLinkOpensThePlansViewAndAPlainChatLinkStillOpensTheChat() {
        #expect(Route(appPath: "/chat/thr_1?fork=fork_9") == .planFork(threadID: "thr_1", forkID: "fork_9"))
        #expect(Route(appPath: "/chat/thr_1") == .thread(id: "thr_1"))
        #expect(Route(appPath: "/chat/thr_1?message=m1") == .thread(id: "thr_1"))
        #expect(Route(appPath: "/chat/thr_1?fork=") == .thread(id: "thr_1"))
    }

    @Test func showingAForkOpensItsChatWithTheViewOnTopAndNeverTwice() {
        let router = Router()
        router.showPlanFork(threadID: "thr_lease", forkID: "fork_lease")
        router.showPlanFork(threadID: "thr_lease", forkID: "fork_lease")
        #expect(router.tab == .chat && router.selectedThread == "thr_lease")
        #expect(router.chatPath == [.planFork(threadID: "thr_lease", forkID: "fork_lease")])
        // Another chat starts a fresh stack rather than stacking this view over the wrong chat.
        router.showPlanFork(threadID: "thr_trip", forkID: "fork_trip")
        #expect(router.selectedThread == "thr_trip" && router.chatPath == [.planFork(threadID: "thr_trip", forkID: "fork_trip")])
    }
}
