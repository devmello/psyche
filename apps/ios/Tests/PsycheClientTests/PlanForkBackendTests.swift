import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// Fork a plan's wire mapping and its Take path (docs/design/fork-a-plan-2026.md §3.4, §4.4, §5.2), against the shapes the
/// Gateway sends:
///  1. `planForks.get` maps to branches, reports, a comparison and the scrub counts, as plain text, tolerating what a
///     newer Gateway adds;
///  2. before `approvals.answer`, the approval's `details.items[]` must be exactly what was ticked (the rule the Mac runs:
///     `stagedApplyMatchesSelection`), with a matching approval as the positive control;
///  3. an approval that needs the Mac (a payment, details too large) is never answered from the phone.
struct PlanForkBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    // MARK: Fixtures in the shapes the Gateway sends

    static func cite(_ source: String?) -> JSONValue {
        var cite: [String: JSONValue] = ["callId": "call_1", "ref": "ref_1"]
        if let source { cite["source"] = .string(source) }
        return .object(cite)
    }

    static func report(summary: String = "A plan.", costs: [JSONValue] = [], dates: [JSONValue] = []) -> JSONValue {
        .object([
            "summary": .string(summary),
            "steps": .array([.object(["id": "s1", "text": "Reply to Sam", "who": "psyche", "stagedId": "stg_1"]),
                             .object(["id": "s2", "text": "Sign it", "who": "you", "when": "2030-03-01"])]),
            "costs": .array(costs), "dates": .array(dates), "people": .array([]), "tradeoffs": .array([]), "risks": .array([]),
            "openQuestions": .array([.object(["id": "q1", "text": "Is it negotiable?"])]),
        ])
    }

    static func cost(_ id: String, amount: Double, period: String = "month", estimate: Bool = false, source: String? = "mail") -> JSONValue {
        .object([
            "id": .string(id), "label": "Rent", "amount": .number(amount), "currency": "USD", "period": .string(period),
            "estimate": .bool(estimate), "cites": .array(source.map { [Self.cite($0)] } ?? []),
        ])
    }

    static func branch(
        _ id: String, ord: Int, label: String, status: String = "reported", report: JSONValue? = nil, scrub: JSONValue? = nil,
        readOwnerOnly: Bool = false
    ) -> JSONValue {
        var branch: [String: JSONValue] = [
            "id": .string(id), "forkId": "fork_1", "ord": .number(Double(ord)), "label": .string(label), "premise": "Assume it.",
            "threadId": .string("thr_b\(ord)"), "taskId": .null, "status": .string(status), "error": .null,
            "report": report ?? .null, "readOwnerOnly": .bool(readOwnerOnly), "taint": .bool(false), "taintSources": .array([]),
            "spentUsd": .number(0.1), "tokens": .number(100), "startedAt": .null, "finishedAt": .null,
            "createdAt": "2030-01-01T05:00:00Z", "updatedAt": "2030-01-01T05:00:00Z",
        ]
        if let scrub { branch["scrub"] = scrub }
        return .object(branch)
    }

    static func fork(status: String = "ready", comparison: JSONValue = .null, error: JSONValue = .null, taken: JSONValue = .null) -> JSONValue {
        .object([
            "id": "fork_1", "threadId": "thr_1", "forkMessageId": "msg_1", "status": .string(status), "error": error,
            "budgetUsd": .number(1), "spentUsd": .number(0.2), "tokens": .number(200), "comparison": comparison,
            "takenBranchId": taken, "takeApprovalId": .null, "createdByDeviceId": .null, "expiresAt": .null,
            "createdAt": "2030-01-01T05:00:00Z", "updatedAt": "2030-01-01T05:00:00Z", "finishedAt": .null,
        ])
    }

    static func detail(branches: [JSONValue], fork: JSONValue? = nil) -> JSONValue {
        .object(["fork": fork ?? Self.fork(), "branches": .array(branches)])
    }

    // MARK: 1. Mapping

    @Test func aForkMapsToBranchesReportsAndTheComparison() async throws {
        let comparison: JSONValue = .object([
            "headline": "Renewing costs less.",
            "rows": .array([.object([
                "dimension": "cost", "label": "Rent", "differs": .bool(true),
                "cells": .array([.object(["branchId": "b1", "itemIds": .array(["c1"]), "note": "Under the cap."]),
                                 .object(["branchId": "b2", "itemIds": .array(["c1"])])]),
            ])]),
            "betterIf": .array([.object(["branchId": "b1", "text": "Better if you want the lowest cost."])]),
        ])
        let (backend, h) = try await live { g in
            g.on("planForks.get") { _ in .success(Self.detail(
                branches: [
                    Self.branch("b2", ord: 1, label: "Move", report: Self.report(costs: [Self.cost("c1", amount: 2400, estimate: true, source: "web")])),
                    Self.branch("b1", ord: 0, label: "Renew", report: Self.report(
                        costs: [Self.cost("c1", amount: 2150), Self.cost("c2", amount: 40, source: nil)],
                        dates: [.object(["id": "d1", "label": "Answer", "date": "2030-03-01", "kind": "deadline", "estimate": .bool(false),
                                         "cites": .array([Self.cite("mail")])])])),
                ],
                fork: Self.fork(comparison: comparison))) }
        }
        let detail = try await backend.planFork(id: "fork_1")
        #expect(h.gateway.received.last?.method == "planForks.get")
        #expect(detail.fork.status == .ready && detail.fork.threadID == "thr_1")
        // Branches are in the order the owner named them, whatever order they arrive in.
        #expect(detail.branches.map(\.label) == ["Renew", "Move"])
        let renew = try #require(detail.branch("b1")?.report)
        #expect(renew.costs.map(\.id) == ["c1", "c2"])
        #expect(renew.costs[0].sources == [.mail] && !renew.costs[0].estimate && !renew.costs[0].unsourced)
        #expect(renew.steps.map(\.prepared) == [true, false] && renew.steps[1].who == .you && renew.steps[1].when == "2030-03-01")
        #expect(renew.questions.map(\.text) == ["Is it negotiable?"])
        #expect(renew.earliestDeadline?.date == "2030-03-01")
        // Totals are summed here from the items, per currency and period, and flag estimates.
        #expect(renew.totals == [PlanForkTotal(currency: "USD", period: .month, amount: 2190, includesEstimate: false)])
        #expect(detail.branch("b2")?.report?.totals.first?.includesEstimate == true)
        let row = try #require(detail.fork.comparison?.rows.first)
        #expect(row.dimension == .cost && row.differs && row.cells.map(\.itemIDs) == [["c1"], ["c1"]])
        #expect(row.cells[0].note == "Under the cap." && row.cells[1].note == nil)
        #expect(detail.fork.comparison?.betterIf == ["b1": "Better if you want the lowest cost."])
        #expect(detail.hiddenItems == 0 && !detail.textHidden)
    }

    @Test func aScrubbedForkCarriesTheCountsAndNoWithheldText() async throws {
        let (backend, _) = try await live { g in
            g.on("planForks.get") { _ in .success(Self.detail(
                branches: [
                    Self.branch(
                        "b1", ord: 0, label: "Out", report: Self.report(summary: "", costs: [Self.cost("c1", amount: 140, estimate: true, source: "web")]),
                        scrub: .object(["hiddenItems": .number(3), "textHidden": .bool(true), "totalsHidden": .bool(true)]), readOwnerOnly: true),
                    Self.branch(
                        "b2", ord: 1, label: "Home", report: Self.report(summary: ""),
                        scrub: .object(["hiddenItems": .number(1), "textHidden": .bool(true), "totalsHidden": .bool(false)]), readOwnerOnly: true),
                ],
                fork: Self.fork(comparison: .object(["headline": "", "rows": .array([]), "betterIf": .array([.object(["branchId": "b1", "text": ""])])])))) }
        }
        let detail = try await backend.planFork(id: "fork_1")
        #expect(detail.hiddenItems == 4)
        #expect(detail.textHidden)
        #expect(detail.branch("b1")?.scrub == PlanForkScrub(hiddenItems: 3, textHidden: true, totalsHidden: true))
        // An empty "Better if" is withheld text: nothing is drawn for it.
        #expect(detail.fork.comparison?.betterIf.isEmpty == true)
        // A branch that read the owner's Memory can't be taken from here: the phone says to open the Mac instead.
        let out = try #require(detail.branch("b1"))
        #expect(detail.isTakeable(out) && !detail.canTake(out) && detail.needsMacToTake(out))
    }

    @Test func anUnscrubbedBranchCanBeTakenAndOnlyWhenTheForkIsReady() async throws {
        let (backend, _) = try await live { g in
            g.on("planForks.get") { _ in .success(Self.detail(branches: [
                Self.branch("b1", ord: 0, label: "Renew", report: Self.report()),
                Self.branch("b2", ord: 1, label: "Move", status: "failed"),
            ])) }
        }
        let detail = try await backend.planFork(id: "fork_1")
        let ok = try #require(detail.branch("b1"))
        let failed = try #require(detail.branch("b2"))
        #expect(detail.canTake(ok) && !detail.needsMacToTake(ok))
        #expect(!detail.canTake(failed))
        var other = detail
        other.fork.status = .taken
        #expect(!other.canTake(ok))
    }

    @Test func unknownStatesReadAsFailedAndTextIsMadeSafe() async throws {
        let (backend, _) = try await live { g in
            g.on("planForks.get") { _ in .success(Self.detail(
                branches: [Self.branch("b1", ord: 0, label: "Re\u{202E}new", status: "from_the_future", report: Self.report(summary: "x"))],
                fork: Self.fork(status: "from_the_future"))) }
        }
        let detail = try await backend.planFork(id: "fork_1")
        #expect(detail.fork.status == .failed && detail.branches[0].status == .failed)
        #expect(!detail.branches[0].label.contains("\u{202E}"))
        #expect(!detail.canTake(detail.branches[0]))
    }

    @Test func aForkWithoutAnIdIsNotFound() async throws {
        let (backend, _) = try await live { g in g.on("planForks.get") { _ in .success(.object(["fork": .object([:]), "branches": .array([])])) } }
        await #expect(throws: BackendError.notFound) { _ = try await backend.planFork(id: "nope") }
    }

    @Test func aTakenForkWhoseChatWasBusyOffersContinue() async throws {
        let (backend, _) = try await live { g in
            g.on("planForks.get") { _ in .success(Self.detail(
                branches: [Self.branch("b1", ord: 0, label: "Renew", report: Self.report())],
                fork: Self.fork(status: "taken", error: .string(planForkContinuePending), taken: "b1"))) }
        }
        #expect(try await backend.planFork(id: "fork_1").continuePending)
    }

    @Test func startingSendsTheOptionsAndTheEstimateIsRead() async throws {
        let (backend, h) = try await live { g in
            g.on("planForks.create") { _ in .success(Self.detail(branches: [Self.branch("b1", ord: 0, label: "A", status: "running")], fork: Self.fork(status: "running"))) }
            g.on("planForks.estimate") { _ in .success(.object(["maxUsd": .number(0.4), "maxTokens": .number(240_000), "budgetUsd": .number(1)])) }
            g.on("planForks.suggest") { _ in .success(.object(["options": .array([
                .object(["label": "Move", "premise": "Assume we move."]), .object(["label": "", "premise": "dropped"]),
            ])])) }
        }
        let options = [PlanForkOption(label: "A", premise: "Assume a."), PlanForkOption(label: "B", premise: "Assume b.")]
        let created = try await backend.createPlanFork(threadID: "thr_1", messageID: "msg_1", options: options)
        #expect(created.fork.status == .running)
        let sent = try #require(h.gateway.received.last { $0.method == "planForks.create" })
        #expect(sent.params?["threadId"]?.string == "thr_1" && sent.params?["messageId"]?.string == "msg_1")
        #expect(sent.params?["branches"]?.array?.compactMap { $0["label"]?.string } == ["A", "B"])
        #expect(sent.idempotencyKey?.isEmpty == false)
        let estimate = try await backend.estimatePlanFork(threadID: "thr_1", options: options)
        #expect(estimate == PlanForkEstimate(maxUsd: 0.4, maxTokens: 240_000, budgetUsd: 1))
        // A suggestion without a name or an assumption is dropped.
        #expect(try await backend.suggestPlanForkOptions(threadID: "thr_1", messageID: "msg_1").map(\.label) == ["Move"])
    }

    // MARK: 2. The hash check before approvals.answer

    static func entry(_ id: String, hash: String, to: [String]? = nil, withheld: Bool = false) -> JSONValue {
        var entry: [String: JSONValue] = ["itemId": .string(id), "tool": "mail_draft", "summary": "x", "bindingHash": .string(hash)]
        if withheld { entry["withheld"] = "messages" }
        if let to { entry["send"] = .object(["to": .array(to.map(JSONValue.string))]) }
        return .object(entry)
    }

    static func approval(
        _ entries: [JSONValue]?, kind: String = "staged_apply", requiresAuthentication: Bool = false, extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        var details: [String: JSONValue] = [:]
        if let entries { details["items"] = .array(entries) }
        for (key, value) in extra { details[key] = value }
        return .object([
            "id": "ap_1", "kind": .string(kind), "status": "pending",
            "requiresAuthentication": .bool(requiresAuthentication), "details": .object(details),
        ])
    }

    static func request(
        items: [(String, String)], sends: [(String, [String])] = [], continuePlan: Bool = true
    ) -> PlanForkTakeRequest {
        PlanForkTakeRequest(
            forkID: "fork_1", branchID: "b1", items: items.map { NightShiftTick(itemID: $0.0, hash: $0.1) },
            sends: sends.map { NightShiftTick(itemID: $0.0, hash: "c-\($0.0)", recipients: $0.1) }, continuePlan: continuePlan)
    }

    func taking(
        approval: JSONValue?, refused: [JSONValue] = [], token: String? = "tok_phone", answer: JSONValue = .object(["approval": .object(["status": "approved"])])
    ) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await live { g in
            g.on("planForks.take") { _ in
                var result: [String: JSONValue] = ["refused": .array(refused)]
                if let approval { result["approval"] = approval }
                if let token { result["answerToken"] = .string(token) }
                return .success(.object(result))
            }
            g.on("approvals.answer") { _ in .success(answer) }
        }
    }

    func answers(_ h: GatewayClientTests.Harness) -> [WireParams] {
        h.gateway.received.filter { $0.method == "approvals.answer" }.map { WireParams(value: $0.params) }
    }

    struct WireParams { let value: JSONValue? }

    @Test func aMatchingApprovalIsAnsweredWithThisPhonesTokenAndOnlyThen() async throws {
        let (backend, h) = try await taking(approval: Self.approval([Self.entry("i1", hash: "h1"), Self.entry("i2", hash: "h2")]))
        let outcome = try await backend.takePlanFork(Self.request(items: [("i1", "h1"), ("i2", "h2")]))
        #expect(outcome == .answered(refused: []))
        let answers = answers(h)
        #expect(answers.count == 1)
        #expect(answers[0].value?["approvalId"]?.string == "ap_1" && answers[0].value?["answerToken"]?.string == "tok_phone")
        #expect(answers[0].value?["decision"]?.string == "approve" && answers[0].value?["scope"]?.string == "once")
        // What went to planForks.take is exactly what was ticked, and it asks for the turn that follows.
        let sent = try #require(h.gateway.received.last { $0.method == "planForks.take" })
        #expect(sent.params?["items"]?.array?.compactMap { $0["bindingHash"]?.string } == ["h1", "h2"])
        #expect(sent.params?["sends"]?.array?.isEmpty == true && sent.params?["continue"]?.bool == true)
        #expect(sent.idempotencyKey?.isEmpty == false)
    }

    /// Every way an approval can differ from the selection. Each refuses with nothing sent to `approvals.answer`.
    static let mismatches: [(String, JSONValue)] = [
        ("a changed hash", approval([entry("i1", hash: "other"), entry("i2", hash: "h2")])),
        ("a swapped item", approval([entry("i1", hash: "h1"), entry("i9", hash: "h2")])),
        ("an extra item", approval([entry("i1", hash: "h1"), entry("i2", hash: "h2"), entry("i3", hash: "h3")])),
        ("a missing item", approval([entry("i1", hash: "h1")])),
        ("a repeated item", approval([entry("i1", hash: "h1"), entry("i1", hash: "h1")])),
        ("no items at all", approval([])),
        ("details without items", approval(nil)),
        ("an item with no hash", approval([entry("i1", hash: "h1"), .object(["itemId": "i2"])])),
        ("an item with no id", approval([entry("i1", hash: "h1"), .object(["bindingHash": "h2"])])),
        ("a withheld row", approval([entry("i1", hash: "h1"), entry("i2", hash: "h2", withheld: true)])),
        ("another kind of approval", approval([entry("i1", hash: "h1"), entry("i2", hash: "h2")], kind: "tool_call")),
        ("a send nobody ticked", approval([entry("i1", hash: "h1"), entry("i2", hash: "h2"), entry("i1:send", hash: "c", to: ["a@x.example"])])),
    ]

    @Test(arguments: mismatches.map(\.0))
    func anApprovalThatIsNotWhatWasTickedIsNeverAnswered(name: String) async throws {
        let approval = try #require(Self.mismatches.first { $0.0 == name }?.1)
        let (backend, h) = try await taking(approval: approval)
        await #expect(throws: PlanForkError.mismatch, "\(name)") {
            _ = try await backend.takePlanFork(Self.request(items: [("i1", "h1"), ("i2", "h2")]))
        }
        #expect(answers(h).isEmpty, "\(name)")
    }

    @Test func aTickedSendNeedsItsSendRowToTheSameRecipients() async throws {
        let ticked = Self.request(items: [("i1", "h1")], sends: [("i1", ["Lee@x.example", "sam@x.example"])])
        // Positive control: the send row repeats the recipients (case and order do not matter).
        let (backend, h) = try await taking(approval: Self.approval([
            Self.entry("i1", hash: "h1"), Self.entry("i1:send", hash: "c-i1", to: ["sam@x.example", "lee@x.example"]),
        ]))
        #expect(try await backend.takePlanFork(ticked) == .answered(refused: []))
        #expect(answers(h).count == 1)
        // A ticked send with no send row, a send row to someone else, and a send row nobody ticked all refuse.
        for rows in [
            [Self.entry("i1", hash: "h1")],
            [Self.entry("i1", hash: "h1"), Self.entry("i1:send", hash: "c-i1", to: ["lee@x.example", "eve@x.example"])],
            [Self.entry("i1", hash: "h1"), Self.entry("i1:send", hash: "c-i1")],
        ] {
            let (backend, h) = try await taking(approval: Self.approval(rows))
            await #expect(throws: PlanForkError.mismatch) { _ = try await backend.takePlanFork(ticked) }
            #expect(answers(h).isEmpty)
        }
        let (plain, h2) = try await taking(approval: Self.approval([
            Self.entry("i1", hash: "h1"), Self.entry("i1:send", hash: "c", to: ["a@x.example"]),
        ]))
        await #expect(throws: PlanForkError.mismatch) { _ = try await plain.takePlanFork(Self.request(items: [("i1", "h1")])) }
        #expect(answers(h2).isEmpty)
    }

    @Test func theGatewayLeavingAnItemOutIsAMismatchNotASilentSkip() async throws {
        // The Mac answers only an approval that lists every ticked item. An item the Gateway refused shows as a
        // mismatch and nothing is applied; the owner reviews again.
        let (backend, h) = try await taking(
            approval: Self.approval([Self.entry("i1", hash: "h1")]),
            refused: [.object(["itemId": "i2", "reason": "That item changed since you looked."])])
        await #expect(throws: PlanForkError.mismatch) { _ = try await backend.takePlanFork(Self.request(items: [("i1", "h1"), ("i2", "h2")])) }
        #expect(answers(h).isEmpty)
    }

    // MARK: 3. Needs the Mac

    @Test func aPaymentIsNotAnsweredFromThePhone() async throws {
        let (backend, h) = try await taking(approval: Self.approval([Self.entry("i1", hash: "h1")], requiresAuthentication: true))
        #expect(try await backend.takePlanFork(Self.request(items: [("i1", "h1")])) == .needsMac(refused: []))
        #expect(answers(h).isEmpty)
    }

    @Test func detailsTooLargeToReadHereGoToTheMac() async throws {
        let huge = String(repeating: "x", count: GatewayBackend.nestedLimit + 1)
        let (backend, h) = try await taking(approval: Self.approval([Self.entry("i1", hash: "h1")], extra: ["notes": .array([.string(huge)])]))
        #expect(try await backend.takePlanFork(Self.request(items: [("i1", "h1")])) == .needsMac(refused: []))
        #expect(answers(h).isEmpty)
    }

    @Test func noAnswerTokenMeansTheMacAnswersIt() async throws {
        let (backend, h) = try await taking(approval: Self.approval([Self.entry("i1", hash: "h1")]), token: nil)
        #expect(try await backend.takePlanFork(Self.request(items: [("i1", "h1")])) == .needsMac(refused: []))
        #expect(answers(h).isEmpty)
    }

    @Test func anAnswerThatIsNotApprovedAppliesNothing() async throws {
        let (backend, _) = try await taking(
            approval: Self.approval([Self.entry("i1", hash: "h1")]), answer: .object(["approval": .object(["status": "expired"])]))
        #expect(try await backend.takePlanFork(Self.request(items: [("i1", "h1")])) == .declined)
    }

    // MARK: No items, every item refused

    @Test func takingWithNothingTickedTakesThePlanWithNoApproval() async throws {
        let (backend, h) = try await taking(approval: nil)
        #expect(try await backend.takePlanFork(Self.request(items: [], continuePlan: false)) == .taken)
        let sent = try #require(h.gateway.received.last { $0.method == "planForks.take" })
        #expect(sent.params?["continue"]?.bool == false && sent.params?["items"]?.array?.isEmpty == true)
        #expect(answers(h).isEmpty)
    }

    @Test func everyTickedItemRefusedLeavesThePlanWaiting() async throws {
        let (backend, h) = try await taking(
            approval: nil, refused: [.object(["itemId": "i1", "reason": "items from your Messages can be applied only on this Mac"])])
        let outcome = try await backend.takePlanFork(Self.request(items: [("i1", "h1")]))
        #expect(outcome == .nothingApproved(refused: [NightShiftRefusal(itemID: "i1", reason: "items from your Messages can be applied only on this Mac")]))
        #expect(answers(h).isEmpty)
    }

    @Test func continuingATakenPlanSendsNothingTickedAndAsksForTheTurn() async throws {
        let (backend, h) = try await taking(approval: nil)
        try await backend.continuePlanFork(forkID: "fork_1", branchID: "b1")
        let sent = try #require(h.gateway.received.last { $0.method == "planForks.take" })
        #expect(sent.params?["items"]?.array?.isEmpty == true && sent.params?["sends"]?.array?.isEmpty == true)
        #expect(sent.params?["continue"]?.bool == true)
    }

    // MARK: Staged items and live events

    @Test func stagedItemsAreReadLikeNightShiftItemsAndAWithheldOneStaysWithheld() async throws {
        let (backend, h) = try await live { g in
            g.on("planForks.staged") { _ in .success(.object(["items": .array([
                NightShiftBackendTests.item(id: "a", summary: "Reply to Sam"),
                NightShiftBackendTests.item(id: "m", summary: "An item from your Messages.", withheld: true),
            ])])) }
        }
        let items = try await backend.planForkStagedItems(forkID: "fork_1", branchID: "b1")
        #expect(items.map(\.id) == ["a", "m"])
        #expect(items[0].canTick && !items[1].canTick && items[1].withheldMessages)
        #expect(h.gateway.received.last?.params?["branchId"]?.string == "b1")
    }

    @Test func theForkBlocksBecomeRowsAndABlockWithoutAnIdIsDropped() async throws {
        let message: JSONValue = .object([
            "id": "m9", "role": "system",
            "blocks": .array([.object(["type": "plan_fork", "forkId": "fork_1"]),
                              .object(["type": "plan_taken", "forkId": "fork_1", "branchId": "b1"]),
                              .object(["type": "plan_fork"])]),
        ])
        let items = await ChatMapping.items(from: message) { _ in nil }
        #expect(items.map(\.id).count == 2)
        #expect(items.contains { if case .planFork(_, "fork_1") = $0 { true } else { false } })
        #expect(items.contains { if case .planTaken(_, "fork_1", "b1") = $0 { true } else { false } })
    }
}
