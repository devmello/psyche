import Foundation

/// Fork a plan's fixture state (docs/design/fork-a-plan-2026.md): one fork the owner can take (a lease, two options, with
/// prepared items) and one the Gateway scrubbed for a phone (branches that read Memory), plus forks started here. Taking a
/// plan checks the hashes the way the Gateway does and marks the fork taken; nothing leaves the phone.
struct PlanForkState: Sendable {
    var forks: [String: PlanForkDetail] = [
        FixtureData.leaseForkID: FixtureData.leaseFork, FixtureData.tripForkID: FixtureData.tripFork,
    ]
    var staged: [String: [NightShiftItem]] = [FixtureData.leaseRenewBranchID: FixtureData.leaseStagedItems]
    /// What this phone asked to take, so a test can see what a fixture take bound.
    var taken: [PlanForkTakeRequest] = []
    var createdOptions: [[PlanForkOption]] = []
    var counter = 0
}

extension FixtureData {
    // MARK: Fork a plan

    public static let leaseForkID = "fork_lease"
    public static let tripForkID = "fork_trip"
    public static let leaseRenewBranchID = "fbr_renew"
    public static let leaseMoveBranchID = "fbr_move"

    public static var leaseFork: PlanForkDetail {
        let renew = PlanForkBranch(
            id: leaseRenewBranchID, ord: 0, label: "Renew the lease", premise: "Assume you renew for 12 months at the 3% cap.",
            status: .reported,
            report: PlanForkReport(
                summary: "Renewing costs the least and keeps the 3% cap if you answer by March 1.",
                steps: [
                    PlanForkStep(id: "s1", text: "Reply to Sam about the 3% cap", who: .psyche, prepared: true),
                    PlanForkStep(id: "s2", text: "Remind you to send the signed lease", who: .psyche, when: "2030-02-28", prepared: true),
                    PlanForkStep(id: "s3", text: "Sign the renewal", who: .you, when: "2030-03-01"),
                ],
                costs: [
                    PlanForkCost(id: "c1", label: "Rent at the 3% cap", amount: 2_150, currency: "USD", period: .month, sources: [.mail]),
                    PlanForkCost(id: "c2", label: "Pet fee", amount: 40, currency: "USD", period: .month, sources: [.files]),
                ],
                dates: [
                    PlanForkDate(id: "d1", label: "Answer the landlord", date: "2030-03-01", kind: .deadline, sources: [.mail]),
                    PlanForkDate(id: "d2", label: "New term starts", date: "2030-04-01", kind: .milestone, sources: [.files]),
                ],
                people: [PlanForkPerson(id: "p1", name: "Sam (landlord)", effect: "Expects an answer by March 1.", sources: [.mail])],
                tradeoffs: [PlanForkTradeoff(id: "t1", gain: "No move, no deposit", giveUp: "The second parking space", sources: [.files])],
                risks: [PlanForkRisk(id: "r1", text: "Sam holds to 4.5% if you reply late.", likelihood: .medium, sources: [.mail])],
                questions: [PlanForkQuestion(id: "q1", text: "Is the pet fee negotiable?")]))
        let move = PlanForkBranch(
            id: leaseMoveBranchID, ord: 1, label: "Move to a new place", premise: "Assume you move out by April 1.",
            status: .reported,
            report: PlanForkReport(
                summary: "Moving costs more up front and gives you a second parking space.",
                steps: [
                    PlanForkStep(id: "s1", text: "Give 60 days notice", who: .you, when: "2030-01-31"),
                    PlanForkStep(id: "s2", text: "Book movers", who: .you),
                ],
                costs: [
                    PlanForkCost(
                        id: "c1", label: "Rent at the new place", amount: 2_400, currency: "USD", period: .month, estimate: true,
                        basis: "Listing average nearby", sources: [.web]),
                    PlanForkCost(id: "c2", label: "Movers and deposit", amount: 4_100, currency: "USD", period: .once, estimate: true, sources: [.web]),
                ],
                dates: [PlanForkDate(id: "d1", label: "Notice due", date: "2030-01-31", kind: .deadline, sources: [.files])],
                people: [PlanForkPerson(id: "p1", name: "Sam (landlord)", effect: "Needs 60 days notice.", sources: [.mail])],
                tradeoffs: [PlanForkTradeoff(id: "t1", gain: "A second parking space", giveUp: "A year of settled routine", sources: [.web])],
                risks: [PlanForkRisk(id: "r1", text: "Two rents overlap for a month.", likelihood: .high, sources: [.web])],
                questions: []))
        func row(_ dimension: PlanComparisonDimension, _ label: String, _ renewIDs: [String], _ moveIDs: [String], differs: Bool, notes: Bool = false)
            -> PlanComparisonRow
        {
            PlanComparisonRow(
                dimension: dimension, label: label,
                cells: [
                    PlanComparisonCell(branchID: leaseRenewBranchID, itemIDs: renewIDs, note: notes ? "Rent stays under the cap." : nil),
                    PlanComparisonCell(branchID: leaseMoveBranchID, itemIDs: moveIDs, note: notes ? "Higher rent plus a one-time cost." : nil),
                ], differs: differs)
        }
        let comparison = PlanComparison(
            headline: "Renewing is cheaper this year; moving buys parking.",
            rows: [
                row(.cost, "What it costs", ["c1", "c2"], ["c1", "c2"], differs: true, notes: true),
                row(.dates, "When it is due", ["d1", "d2"], ["d1"], differs: true),
                row(.people, "Who is affected", ["p1"], ["p1"], differs: false),
                row(.tradeoffs, "What you give up", ["t1"], ["t1"], differs: true),
                row(.risks, "What could go wrong", ["r1"], ["r1"], differs: true),
            ],
            betterIf: [
                leaseRenewBranchID: "Better if you want the lowest cost and no move this year.",
                leaseMoveBranchID: "Better if a second parking space matters more than the extra cost.",
            ])
        return PlanForkDetail(
            fork: PlanForkInfo(id: leaseForkID, threadID: "thr_lease", status: .ready, budgetUsd: 1, spentUsd: 0.31, comparison: comparison),
            branches: [renew, move])
    }

    /// The prepared items of the lease fork's first branch. The third is made from Messages: a phone gets the generic line.
    public static var leaseStagedItems: [NightShiftItem] {
        [
            NightShiftItem(
                id: "fs_reply", domain: .mail, tool: "mail_draft", summary: "Reply to Sam about the 3% cap",
                why: "The lease caps increases at 3%.", bindingHash: "sha256:fork-reply", untrusted: true,
                rows: [
                    NightShiftRow(label: "Recipient", value: "sam@homes.example"),
                    NightShiftRow(label: "Subject", value: "Re: Lease renewal"),
                    NightShiftRow(label: "Body", value: "Hi Sam, section 6 caps increases at 3%. Could you confirm?"),
                ],
                fullBody: "Hi Sam, section 6 caps increases at 3%. Could you confirm?",
                send: NightShiftSend(recipients: ["sam@homes.example"], contentHash: "sha256:fork-reply-send")),
            NightShiftItem(
                id: "fs_rem", domain: .reminders, tool: "reminders_create", summary: "Remind you to send the signed lease",
                bindingHash: "sha256:fork-rem", rows: [NightShiftRow(label: "Due", value: "Thu 28 Feb, 9:00")]),
            NightShiftItem(
                id: "fs_msg", domain: .reminders, tool: "reminders_create",
                summary: "An item from your Messages. Open Psyche on this Mac to see it.", bindingHash: "sha256:fork-msg",
                withheldMessages: true),
        ]
    }

    /// A fork the Gateway scrubbed for a phone: its branches read Memory, so their text and some items stay on the Mac.
    public static var tripFork: PlanForkDetail {
        let out = PlanForkBranch(
            id: "fbr_out", ord: 0, label: "Dinner out", premise: "Assume you book a table for Saturday at 18:00.", status: .reported,
            report: PlanForkReport(
                costs: [PlanForkCost(id: "c1", label: "Dinner for two", amount: 140, currency: "USD", period: .once, estimate: true, sources: [.web])]),
            scrub: PlanForkScrub(hiddenItems: 3, textHidden: true, totalsHidden: true), readOwnerOnly: true)
        let home = PlanForkBranch(
            id: "fbr_home", ord: 1, label: "Cook at home", premise: "Assume you cook on Saturday.", status: .reported,
            report: PlanForkReport(
                costs: [PlanForkCost(id: "c1", label: "Groceries", amount: 55, currency: "USD", period: .once, estimate: true, sources: [.web])]),
            scrub: PlanForkScrub(hiddenItems: 1, textHidden: true, totalsHidden: false), readOwnerOnly: true)
        let comparison = PlanComparison(
            headline: "",
            rows: [
                PlanComparisonRow(
                    dimension: .cost, label: "",
                    cells: [
                        PlanComparisonCell(branchID: "fbr_out", itemIDs: ["c1"]), PlanComparisonCell(branchID: "fbr_home", itemIDs: ["c1"]),
                    ], differs: true)
            ])
        return PlanForkDetail(
            fork: PlanForkInfo(id: tripForkID, threadID: "thr_trip", status: .ready, budgetUsd: 1, spentUsd: 0.22, comparison: comparison),
            branches: [out, home])
    }

    /// A fork started on the phone: running, or finished with a short report so the demo has something to compare.
    static func startedFork(id: String, threadID: String, options: [PlanForkOption], ready: Bool) -> PlanForkDetail {
        let branches = options.enumerated().map { index, option in
            PlanForkBranch(
                id: "\(id)_b\(index)", ord: index, label: option.label, premise: option.premise,
                status: ready ? .reported : .running,
                report: ready
                    ? PlanForkReport(
                        summary: "Worked out from your chat: \(option.premise)",
                        steps: [PlanForkStep(id: "s1", text: "Decide and tell Psyche", who: .you)],
                        costs: [
                            PlanForkCost(
                                id: "c1", label: option.label, amount: Double(500 * (index + 1)), currency: "USD", period: .once, estimate: true)
                        ])
                    : nil)
        }
        let comparison = ready
            ? PlanComparison(
                headline: "Two ways to go.",
                rows: [
                    PlanComparisonRow(
                        dimension: .cost, label: "What it costs",
                        cells: branches.map { PlanComparisonCell(branchID: $0.id, itemIDs: ["c1"]) }, differs: true)
                ])
            : nil
        return PlanForkDetail(
            fork: PlanForkInfo(id: id, threadID: threadID, status: ready ? .ready : .running, comparison: comparison),
            branches: branches)
    }
}

extension FixtureBackend: PlanForkBackend {
    public func suggestPlanForkOptions(threadID: String, messageID: String) async throws -> [PlanForkOption] {
        await pause()
        return [
            PlanForkOption(label: "Do it now", premise: "Assume you go ahead this month."),
            PlanForkOption(label: "Wait a quarter", premise: "Assume you wait three months."),
        ]
    }

    public func estimatePlanFork(threadID: String, options: [PlanForkOption]) async throws -> PlanForkEstimate {
        await pause()
        return PlanForkEstimate(maxUsd: 0.2 * Double(options.count), maxTokens: 120_000 * options.count, budgetUsd: 1)
    }

    public func createPlanFork(threadID: String, messageID: String, options: [PlanForkOption]) async throws -> PlanForkDetail {
        await pause()
        guard options.count >= PlanForkOption.minOptions, options.count <= PlanForkOption.maxOptions else {
            throw BackendError.refused("Pick two to four options.")
        }
        guard chatState.threads[threadID] != nil else { throw BackendError.notFound }
        if planForkState.forks.values.contains(where: { $0.fork.threadID == threadID && $0.fork.status.isLive }) {
            throw BackendError.refused("Another plan for this chat is still being worked out.")
        }
        planForkState.counter += 1
        let id = "fork_new\(planForkState.counter)"
        let started = FixtureData.startedFork(id: id, threadID: threadID, options: options, ready: false)
        planForkState.forks[id] = started
        planForkState.createdOptions.append(options)
        publish(.changed(.planForks))
        // The app's shared instance finishes the fork a moment later; a test steps it with `finishPlanFork`.
        if latency > .zero {
            Task { [self] in
                try? await Task.sleep(for: .seconds(3))
                finishPlanFork(id: id)
            }
        }
        return started
    }

    /// Fixture step: the branches report and the fork becomes ready, as the Gateway does when the runs end.
    func finishPlanFork(id: String) {
        guard let current = planForkState.forks[id], current.fork.status.isLive else { return }
        let options = current.branches.map { PlanForkOption(label: $0.label, premise: $0.premise) }
        planForkState.forks[id] = FixtureData.startedFork(id: id, threadID: current.fork.threadID, options: options, ready: true)
        publish(.changed(.planForks))
    }

    public func planFork(id: String) async throws -> PlanForkDetail {
        await pause()
        guard let detail = planForkState.forks[id] else { throw BackendError.notFound }
        return detail
    }

    public func planForkStagedItems(forkID: String, branchID: String) async throws -> [NightShiftItem] {
        await pause()
        guard planForkState.forks[forkID]?.branch(branchID) != nil else { throw BackendError.notFound }
        return planForkState.staged[branchID] ?? []
    }

    public func cancelPlanFork(forkID: String, branchID: String?) async throws {
        await pause()
        guard var detail = planForkState.forks[forkID] else { throw BackendError.notFound }
        for index in detail.branches.indices where branchID == nil || detail.branches[index].id == branchID {
            if detail.branches[index].status.isLive { detail.branches[index].status = .cancelled }
        }
        if !detail.branches.contains(where: { $0.status.isLive }) { detail.fork.status = .cancelled }
        planForkState.forks[forkID] = detail
        publish(.changed(.planForks))
    }

    public func dismissPlanFork(forkID: String) async throws {
        await pause()
        guard var detail = planForkState.forks[forkID] else { throw BackendError.notFound }
        guard detail.fork.status == .ready || detail.fork.status == .failed else { return }
        detail.fork.status = .dismissed
        planForkState.forks[forkID] = detail
        publish(.changed(.planForks))
    }

    public func takePlanFork(_ request: PlanForkTakeRequest) async throws -> PlanForkTakeOutcome {
        guard var detail = planForkState.forks[request.forkID], let branch = detail.branch(request.branchID) else {
            throw BackendError.notFound
        }
        guard detail.fork.status == .ready else { throw BackendError.refused("The plan is \(detail.fork.status.rawValue).") }
        guard branch.status == .reported else { throw BackendError.refused("That option has no report to take.") }
        // The Gateway refuses an item whose hash moved, or one withheld from a phone, instead of putting it in the approval.
        let items = planForkState.staged[request.branchID] ?? []
        var refused: [NightShiftRefusal] = []
        var good: [NightShiftTick] = []
        for tick in request.items {
            guard let item = items.first(where: { $0.id == tick.itemID }) else {
                refused.append(NightShiftRefusal(itemID: tick.itemID, reason: "That item is gone."))
                continue
            }
            if item.withheldMessages {
                refused.append(NightShiftRefusal(
                    itemID: tick.itemID, reason: "items from your Messages can be applied only in Psyche on this Mac"))
            } else if item.status != .ready || item.bindingHash != tick.hash {
                refused.append(NightShiftRefusal(itemID: tick.itemID, reason: "That item changed since you looked."))
            } else {
                good.append(tick)
            }
        }
        planForkState.taken.append(request)
        if !request.items.isEmpty && good.isEmpty { return .nothingApproved(refused: refused) }
        detail.fork.status = .taken
        detail.fork.takenBranchID = request.branchID
        planForkState.forks[request.forkID] = detail
        if !good.isEmpty {
            planForkState.staged[request.branchID] = items.map { item in
                var item = item
                if good.contains(where: { $0.itemID == item.id }) { item.status = .applied }
                return item
            }
        }
        // The Gateway posts "Plan taken" in the chat when the plan is taken.
        if var thread = chatState.threads[detail.fork.threadID] {
            let line = ChatItem.planTaken(id: "taken_\(request.forkID)", forkID: request.forkID, branchID: request.branchID)
            thread.items.append(line)
            chatState.threads[detail.fork.threadID] = thread
            publish(.chat(.item(threadID: detail.fork.threadID, item: line)))
        }
        publish(.changed(.planForks))
        return request.items.isEmpty ? .taken : .answered(refused: refused)
    }

    public func continuePlanFork(forkID: String, branchID: String) async throws {
        guard var detail = planForkState.forks[forkID], detail.continuePending else { return }
        detail.fork.error = nil
        planForkState.forks[forkID] = detail
        publish(.changed(.planForks))
    }
}
