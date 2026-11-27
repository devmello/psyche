import Foundation

import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// Counts the estimate calls a start sheet makes, over the fixture backend (every other call passes through).
actor CountingPlanForks: PlanForkBackend {
    let base = FixtureBackend()
    private(set) var estimates = 0

    func suggestPlanForkOptions(threadID: String, messageID: String) async throws -> [PlanForkOption] {
        try await base.suggestPlanForkOptions(threadID: threadID, messageID: messageID)
    }

    func estimatePlanFork(threadID: String, options: [PlanForkOption]) async throws -> PlanForkEstimate {
        estimates += 1
        return try await base.estimatePlanFork(threadID: threadID, options: options)
    }

    func createPlanFork(threadID: String, messageID: String, options: [PlanForkOption]) async throws -> PlanForkDetail {
        try await base.createPlanFork(threadID: threadID, messageID: messageID, options: options)
    }

    func planFork(id: String) async throws -> PlanForkDetail { try await base.planFork(id: id) }

    func planForkStagedItems(forkID: String, branchID: String) async throws -> [NightShiftItem] {
        try await base.planForkStagedItems(forkID: forkID, branchID: branchID)
    }

    func cancelPlanFork(forkID: String, branchID: String?) async throws {
        try await base.cancelPlanFork(forkID: forkID, branchID: branchID)
    }

    func dismissPlanFork(forkID: String) async throws { try await base.dismissPlanFork(forkID: forkID) }

    func takePlanFork(_ request: PlanForkTakeRequest) async throws -> PlanForkTakeOutcome {
        try await base.takePlanFork(request)
    }

    func continuePlanFork(forkID: String, branchID: String) async throws {
        try await base.continuePlanFork(forkID: forkID, branchID: branchID)
    }
}

@MainActor
struct PlanForkEstimateDebounceTests {
    /// Typing refreshes on every keystroke. Each refresh supersedes the last, so only the final one, after the pause,
    /// reaches the Gateway.
    @Test func aBurstOfEditsSendsOneEstimateAfterTheTypingPauses() async throws {
        let plans = CountingPlanForks()
        let model = PlanForkStartModel(threadID: "thr_lease", messageID: "l2", store: plans)
        let first = model.drafts[0].id
        let second = model.drafts[1].id
        model.edit(first, label: "Do", premise: "Assume you go ahead.")
        model.edit(second, label: "Wait", premise: "Assume you wait.")
        var refreshes: [Task<Void, Never>] = []
        for keystroke in ["D", "Do", "Do i", "Do it"] {
            model.edit(first, label: keystroke)
            refreshes.forEach { $0.cancel() }
            refreshes.append(Task { await model.refreshEstimate() })
        }
        await refreshes.last?.value
        #expect(await plans.estimates == 1)
        // Positive control: the estimate that went out is the one the sheet shows.
        #expect(model.estimate != nil)
    }

    /// A superseded refresh must not blank a valid estimate to nil while the next one is pending.
    @Test func aCancelledRefreshKeepsTheCurrentEstimate() async throws {
        let plans = CountingPlanForks()
        let model = PlanForkStartModel(threadID: "thr_lease", messageID: "l2", store: plans)
        model.edit(model.drafts[0].id, label: "A", premise: "a")
        model.edit(model.drafts[1].id, label: "B", premise: "b")
        await model.refreshEstimate()
        let shown = try #require(model.estimate)
        let superseded = Task { await model.refreshEstimate() }
        superseded.cancel()
        await superseded.value
        #expect(model.estimate?.maxTokens == shown.maxTokens)
        #expect(await plans.estimates == 1)
    }
}
