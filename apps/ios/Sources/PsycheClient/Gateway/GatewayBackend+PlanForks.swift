import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Fork a plan over `planForks.*` (docs/design/fork-a-plan-2026.md §3.4, §4.4, §5.2, §7.2). The Gateway scrubs what a phone
// may see (§4.4), so this maps only what arrives and counts what was withheld. Taking a plan is two steps and the second
// is the owner's tap: `planForks.take` mints one `staged_apply` approval for the ticked items, then this phone answers it
// with the token it was handed, but only after the approval's own item hashes were compared with what the owner ticked
// and saw (`planForkApprovalMatches`, the same rule as `stagedApplyMatchesSelection` in packages/protocol, which the Mac
// runs before it answers). Any difference refuses the answer: the tap approves exactly what was shown.
extension GatewayBackend {
    public func suggestPlanForkOptions(threadID: String, messageID: String) async throws -> [PlanForkOption] {
        let result = try await call("planForks.suggest", .obj(["threadId": .string(threadID), "messageId": .string(messageID)]))
        return Self.planForkOptions(result["options"])
    }

    public func estimatePlanFork(threadID: String, options: [PlanForkOption]) async throws -> PlanForkEstimate {
        let result = try await call(
            "planForks.estimate", .obj(["threadId": .string(threadID), "branches": Self.planForkOptionParams(options)]))
        return PlanForkEstimate(
            maxUsd: result["maxUsd"]?.double, maxTokens: max(0, result["maxTokens"]?.int ?? 0),
            budgetUsd: result["budgetUsd"]?.double ?? 0)
    }

    public func createPlanFork(threadID: String, messageID: String, options: [PlanForkOption]) async throws -> PlanForkDetail {
        let result = try await call(
            "planForks.create",
            .obj([
                "threadId": .string(threadID), "messageId": .string(messageID),
                "branches": Self.planForkOptionParams(options),
            ]))
        guard let detail = Self.planForkDetail(result) else { throw BackendError.notFound }
        return detail
    }

    public func planFork(id: String) async throws -> PlanForkDetail {
        let result = try await call("planForks.get", .obj(["forkId": .string(id)]))
        guard let detail = Self.planForkDetail(result) else { throw BackendError.notFound }
        return detail
    }

    public func planForkStagedItems(forkID: String, branchID: String) async throws -> [NightShiftItem] {
        let result = try await call("planForks.staged", .obj(["forkId": .string(forkID), "branchId": .string(branchID)]))
        return (result["items"]?.array ?? []).compactMap { Self.nightShiftItem($0) }
    }

    public func cancelPlanFork(forkID: String, branchID: String?) async throws {
        var params: [String: JSONValue] = ["forkId": .string(forkID)]
        if let branchID { params["branchId"] = .string(branchID) }
        _ = try await call("planForks.cancel", .object(params))
    }

    public func dismissPlanFork(forkID: String) async throws {
        _ = try await call("planForks.dismiss", .obj(["forkId": .string(forkID)]))
    }

    public func continuePlanFork(forkID: String, branchID: String) async throws {
        _ = try await call("planForks.take", Self.planForkTakeParams(PlanForkTakeRequest(
            forkID: forkID, branchID: branchID, items: [], sends: [], continuePlan: true)))
    }

    public func takePlanFork(_ request: PlanForkTakeRequest) async throws -> PlanForkTakeOutcome {
        let result = try await call("planForks.take", Self.planForkTakeParams(request))
        let refused = Self.nightShiftRefusals(result["refused"])
        guard let approval = result["approval"], let approvalID = approval["id"]?.string else {
            // No approval: either nothing was ticked and the plan is taken at once, or every ticked item was refused.
            return request.items.isEmpty && request.sends.isEmpty ? .taken : .nothingApproved(refused: refused)
        }
        // The check that stands between the owner's tap and the Gateway: refuse before anything is answered.
        guard Self.planForkApprovalMatches(approval, request: request) else { throw PlanForkError.mismatch }
        // A payment, or details too large to show in full here, is never answered from the phone.
        if approval["requiresAuthentication"]?.bool == true || Self.detailsNeedMac(approval["details"]) {
            return .needsMac(refused: refused)
        }
        guard approval["status"]?.string == "pending" || approval["status"] == nil,
              let token = result["answerToken"]?.string
        else { return .needsMac(refused: refused) }
        let answer = try await call("approvals.answer", Self.suggestionAnswerParams(approvalID: approvalID, token: token))
        // The Mac reads the answer the same way: anything but approved means nothing is applied.
        if let status = answer["approval"]?["status"]?.string, status != "approved" { return .declined }
        return .answered(refused: refused)
    }

    // MARK: - The hash check (static, so tests pin it)

    /// The `<itemId>:send` child of a draft's send (`SEND_CHILD` in packages/protocol).
    static let planForkSendSuffix = ":send"

    /// True when the approval is a `staged_apply` whose items are exactly what the owner ticked. This is
    /// `stagedApplyMatchesSelection` (packages/protocol/src/schemas/plan-forks.ts), run by the Mac before it answers, and
    /// nothing looser:
    ///  - the approval's `details.items` are a list, and every entry has a string `itemId` and `bindingHash`;
    ///  - the draft entries (no `:send` suffix) have no repeated id, and are the ticked items one for one, each with the
    ///    hash the owner saw (no refused item may be missing: a changed set means the owner is not shown what is applied);
    ///  - the `:send` entries are exactly the ticked sends.
    /// On top of that, as Night shift does on this phone: a row marked `withheld` fails (this phone ticks only what it saw
    /// in full), and a send row must repeat the recipients the owner saw (`send.to`).
    static func planForkApprovalMatches(_ approval: JSONValue, request: PlanForkTakeRequest) -> Bool {
        guard approval["kind"]?.string == "staged_apply", let entries = approval["details"]?["items"]?.array else { return false }
        var drafts: [String: String] = [:]
        var sends: [String: [String]] = [:]
        for entry in entries {
            guard let id = entry["itemId"]?.string, let hash = entry["bindingHash"]?.string, entry["withheld"] == nil else { return false }
            if id.hasSuffix(planForkSendSuffix) {
                let draft = String(id.dropLast(planForkSendSuffix.count))
                guard sends[draft] == nil, let to = entry["send"]?["to"]?.array, to.allSatisfy({ $0.string != nil }) else { return false }
                sends[draft] = to.compactMap(\.string)
            } else {
                guard drafts[id] == nil else { return false }
                drafts[id] = hash
            }
        }
        var ticked: [String: String] = [:]
        for tick in request.items {
            guard ticked[tick.itemID] == nil else { return false }
            ticked[tick.itemID] = tick.hash
        }
        guard drafts.count == ticked.count else { return false }
        for (id, hash) in ticked where drafts[id] != hash { return false }
        var tickedSends: [String: [String]] = [:]
        for tick in request.sends {
            guard tickedSends[tick.itemID] == nil else { return false }
            tickedSends[tick.itemID] = tick.recipients
        }
        guard sends.count == tickedSends.count else { return false }
        for (id, to) in sends {
            guard let seen = tickedSends[id], recipients(seen) == recipients(to) else { return false }
        }
        return true
    }

    private static func recipients(_ list: [String]) -> [String] {
        list.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.sorted()
    }

    static func planForkTakeParams(_ request: PlanForkTakeRequest) -> JSONValue {
        .obj([
            "forkId": .string(request.forkID), "branchId": .string(request.branchID),
            "items": .array(request.items.map { .obj(["itemId": .string($0.itemID), "bindingHash": .string($0.hash)]) }),
            "sends": .array(request.sends.map { .obj(["itemId": .string($0.itemID), "sendHash": .string($0.hash)]) }),
            "continue": .bool(request.continuePlan),
        ])
    }

    static func planForkOptionParams(_ options: [PlanForkOption]) -> JSONValue {
        .array(options.map { .obj(["label": .string($0.label), "premise": .string($0.premise)]) })
    }

    // MARK: - Mapping

    static func planForkOptions(_ value: JSONValue?) -> [PlanForkOption] {
        (value?.array ?? []).compactMap { option in
            guard let label = option["label"]?.string, let premise = option["premise"]?.string,
                  !label.isEmpty, !premise.isEmpty
            else { return nil }
            return PlanForkOption(
                label: String(DisplaySafe.text(label).prefix(PlanForkOption.labelLimit)),
                premise: String(DisplaySafe.text(premise).prefix(PlanForkOption.premiseLimit)))
        }
    }

    /// `{fork, branches}` as `planForks.get` and `.create` return it. Nil when the fork has no id.
    static func planForkDetail(_ result: JSONValue) -> PlanForkDetail? {
        guard let fork = result["fork"], let id = fork["id"]?.string, let thread = fork["threadId"]?.string else { return nil }
        let comparison = fork["comparison"].flatMap(planComparison)
        let info = PlanForkInfo(
            id: id, threadID: thread, status: PlanForkStatus(wire: fork["status"]?.string),
            error: fork["error"]?.string.map(DisplaySafe.text), budgetUsd: fork["budgetUsd"]?.double ?? 0,
            spentUsd: fork["spentUsd"]?.double ?? 0, comparison: comparison, takenBranchID: fork["takenBranchId"]?.string)
        let branches = (result["branches"]?.array ?? []).compactMap(planForkBranch)
        return PlanForkDetail(fork: info, branches: branches)
    }

    static func planForkBranch(_ branch: JSONValue) -> PlanForkBranch? {
        guard let id = branch["id"]?.string, let label = branch["label"]?.string else { return nil }
        let scrub = branch["scrub"].map { scrub in
            PlanForkScrub(
                hiddenItems: max(0, scrub["hiddenItems"]?.int ?? 0), textHidden: scrub["textHidden"]?.bool == true,
                totalsHidden: scrub["totalsHidden"]?.bool == true)
        } ?? .none
        return PlanForkBranch(
            id: id, ord: branch["ord"]?.int ?? 0, label: DisplaySafe.text(label),
            premise: DisplaySafe.text(branch["premise"]?.string ?? ""),
            status: PlanForkBranchStatus(wire: branch["status"]?.string),
            error: branch["error"]?.string.map(DisplaySafe.text),
            report: branch["report"].flatMap(planForkReport), scrub: scrub, readOwnerOnly: branch["readOwnerOnly"]?.bool == true)
    }

    private static func sources(_ item: JSONValue) -> [PlanForkSource] {
        var seen: [PlanForkSource] = []
        for cite in item["cites"]?.array ?? [] {
            if let source = cite["source"]?.string.flatMap(PlanForkSource.init(rawValue:)), !seen.contains(source) { seen.append(source) }
        }
        return seen
    }

    private static func text(_ value: JSONValue?) -> String { DisplaySafe.text(value?.string ?? "") }

    static func planForkReport(_ report: JSONValue) -> PlanForkReport? {
        guard report.object != nil else { return nil }
        func list<T>(_ key: String, _ make: (JSONValue, String) -> T?) -> [T] {
            (report[key]?.array ?? []).compactMap { item in item["id"]?.string.flatMap { make(item, $0) } }
        }
        return PlanForkReport(
            summary: text(report["summary"]),
            steps: list("steps") { item, id in
                PlanForkStep(
                    id: id, text: text(item["text"]), who: item["who"]?.string == "you" ? .you : .psyche,
                    when: item["when"]?.string, prepared: item["stagedId"]?.string != nil)
            },
            costs: list("costs") { item, id in
                guard let amount = item["amount"]?.double, amount.isFinite else { return nil }
                return PlanForkCost(
                    id: id, label: text(item["label"]), amount: amount,
                    currency: DisplaySafe.text(item["currency"]?.string ?? "").uppercased(),
                    period: item["period"]?.string.flatMap(PlanForkCost.Period.init(rawValue:)) ?? .once,
                    estimate: item["estimate"]?.bool == true,
                    basis: item["basis"]?.string.map(DisplaySafe.text), sources: sources(item),
                    unsourced: item["unsourced"]?.bool == true)
            },
            dates: list("dates") { item, id in
                guard let date = item["date"]?.string else { return nil }
                return PlanForkDate(
                    id: id, label: text(item["label"]), date: date,
                    kind: item["kind"]?.string.flatMap(PlanForkDate.Kind.init(rawValue:)) ?? .event,
                    estimate: item["estimate"]?.bool == true, sources: sources(item), unsourced: item["unsourced"]?.bool == true)
            },
            people: list("people") { item, id in
                PlanForkPerson(
                    id: id, name: text(item["name"]), effect: text(item["effect"]), sources: sources(item),
                    unsourced: item["unsourced"]?.bool == true)
            },
            tradeoffs: list("tradeoffs") { item, id in
                PlanForkTradeoff(
                    id: id, gain: item["gain"]?.string.map(DisplaySafe.text), giveUp: text(item["giveUp"]),
                    sources: sources(item), unsourced: item["unsourced"]?.bool == true)
            },
            risks: list("risks") { item, id in
                PlanForkRisk(
                    id: id, text: text(item["text"]),
                    likelihood: item["likelihood"]?.string.flatMap(PlanForkRisk.Likelihood.init(rawValue:)) ?? .medium,
                    sources: sources(item), unsourced: item["unsourced"]?.bool == true)
            },
            questions: list("openQuestions") { item, id in PlanForkQuestion(id: id, text: text(item["text"])) })
    }

    static func planComparison(_ comparison: JSONValue) -> PlanComparison? {
        guard comparison.object != nil else { return nil }
        let rows = (comparison["rows"]?.array ?? []).compactMap { row -> PlanComparisonRow? in
            guard let dimension = row["dimension"]?.string.flatMap(PlanComparisonDimension.init(rawValue:)) else { return nil }
            let cells = (row["cells"]?.array ?? []).compactMap { cell -> PlanComparisonCell? in
                guard let branch = cell["branchId"]?.string else { return nil }
                let note = cell["note"]?.string.map(DisplaySafe.text).flatMap { $0.isEmpty ? nil : $0 }
                return PlanComparisonCell(branchID: branch, itemIDs: (cell["itemIds"]?.array ?? []).compactMap(\.string), note: note)
            }
            return PlanComparisonRow(dimension: dimension, label: text(row["label"]), cells: cells, differs: row["differs"]?.bool == true)
        }
        var betterIf: [String: String] = [:]
        for entry in comparison["betterIf"]?.array ?? [] {
            if let branch = entry["branchId"]?.string, case let line = text(entry["text"]), !line.isEmpty { betterIf[branch] = line }
        }
        return PlanComparison(headline: text(comparison["headline"]), rows: rows, betterIf: betterIf)
    }
}
