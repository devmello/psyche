import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// A mocked `ModelsBackend`: scripted answers, and a record of what the screen asked for.
private actor MockModels: ModelsBackend {
    var choices: ModelChoices
    var setError: BackendError?
    var loadError: BackendError?
    var usageReport: UsageReport
    /// Models the Gateway refuses as a primary unless the owner overrides (`policy_denied`).
    var chatOnlyRefs: Set<String>
    private(set) var setCalls: [String] = []
    private(set) var overrideFlags: [Bool] = []

    init(choices: ModelChoices, setError: BackendError? = nil, loadError: BackendError? = nil,
         chatOnlyRefs: Set<String> = [],
         usageReport: UsageReport = UsageReport(today: UsageTotals(tokens: 0, costUsd: 0, turns: 0),
                                                month: UsageTotals(tokens: 0, costUsd: 0, turns: 0),
                                                byModel: [], budgetUsd: nil)) {
        self.choices = choices
        self.setError = setError
        self.loadError = loadError
        self.chatOnlyRefs = chatOnlyRefs
        self.usageReport = usageReport
    }

    func modelChoices() async throws -> ModelChoices {
        if let loadError { throw loadError }
        return choices
    }

    func setDefaultModel(_ ref: String, override: Bool) async throws {
        setCalls.append(ref)
        overrideFlags.append(override)
        if !override, chatOnlyRefs.contains(ref) {
            throw BackendError.policyDenied("\(ref) is chat-only; pass override to use it for agent threads")
        }
        if let setError { throw setError }
        choices.defaultRef = ref
    }

    func usage() async throws -> UsageReport {
        if let loadError { throw loadError }
        return usageReport
    }
}

@MainActor
struct DefaultModelModelTests {
    static let twoModels = ModelChoices(
        models: [
            ModelChoice(ref: "anthropic/claude-sonnet", providerLabel: "Anthropic"),
            ModelChoice(ref: "lmstudio/qwen-coder", providerLabel: "LM Studio"),
        ],
        defaultRef: "anthropic/claude-sonnet")

    @Test func loadingShowsTheGatewaysModelsAndTheDefault() async {
        let model = DefaultModelModel(store: MockModels(choices: Self.twoModels))
        await model.load()
        #expect(model.phase.value == Self.twoModels)
        #expect(model.refusal == nil)
    }

    @Test func aFailedLoadSaysSoAndTheRetryReadsAgain() async {
        let mock = MockModels(choices: Self.twoModels, loadError: .unreachable)
        let model = DefaultModelModel(store: mock)
        await model.load()
        guard case .failed = model.phase else {
            Issue.record("expected a failed phase, got \(model.phase)")
            return
        }
        await mock.setLoadErrorForTest(nil)
        await model.load()
        #expect(model.phase.value == Self.twoModels)
    }

    @Test func choosingAModelSetsItAndShowsWhatTheGatewayKept() async {
        let mock = MockModels(choices: Self.twoModels)
        let model = DefaultModelModel(store: mock)
        await model.load()
        await model.choose("lmstudio/qwen-coder")
        #expect(await mock.setCalls == ["lmstudio/qwen-coder"])
        #expect(model.phase.value?.defaultRef == "lmstudio/qwen-coder")
        #expect(model.refusal == nil)
        #expect(model.choosing == nil)
    }

    @Test func aRefusalIsShownAndTheDefaultDoesNotMove() async {
        let mock = MockModels(choices: Self.twoModels, setError: .refused("Needs admin access."))
        let model = DefaultModelModel(store: mock)
        await model.load()
        await model.choose("lmstudio/qwen-coder")
        #expect(model.refusal == "Needs admin access.")
        #expect(model.phase.value?.defaultRef == "anthropic/claude-sonnet")
        #expect(model.choosing == nil)
    }

    @Test func aChatOnlyRefusalOffersUseAnywayAndDoesNotMoveTheDefault() async {
        let mock = MockModels(choices: Self.twoModels, chatOnlyRefs: ["lmstudio/qwen-coder"])
        let model = DefaultModelModel(store: mock)
        await model.load()
        await model.choose("lmstudio/qwen-coder")
        #expect(model.chatOnly == ChatOnlyPick(
            ref: "lmstudio/qwen-coder",
            message: "lmstudio/qwen-coder is chat-only; pass override to use it for agent threads"))
        #expect(model.refusal == nil)
        #expect(model.phase.value?.defaultRef == "anthropic/claude-sonnet")
        #expect(model.choosing == nil)
    }

    @Test func useAnywayResendsTheChoiceWithOverrideTrue() async {
        let mock = MockModels(choices: Self.twoModels, chatOnlyRefs: ["lmstudio/qwen-coder"])
        let model = DefaultModelModel(store: mock)
        await model.load()
        await model.choose("lmstudio/qwen-coder")
        await model.useAnyway()
        #expect(await mock.setCalls == ["lmstudio/qwen-coder", "lmstudio/qwen-coder"])
        #expect(await mock.overrideFlags == [false, true])
        #expect(model.chatOnly == nil)
        #expect(model.refusal == nil)
        #expect(model.phase.value?.defaultRef == "lmstudio/qwen-coder")
    }

    @Test func keepingTheCurrentModelDismissesTheRefusalWithoutSendingOverride() async {
        let mock = MockModels(choices: Self.twoModels, chatOnlyRefs: ["lmstudio/qwen-coder"])
        let model = DefaultModelModel(store: mock)
        await model.load()
        await model.choose("lmstudio/qwen-coder")
        model.keepCurrent()
        #expect(model.chatOnly == nil)
        #expect(await mock.overrideFlags == [false])
        #expect(model.phase.value?.defaultRef == "anthropic/claude-sonnet")
    }

    @Test func aReloadFailureAfterASuccessfulSetIsALoadErrorWithRetry() async {
        let mock = MockModels(choices: Self.twoModels)
        let model = DefaultModelModel(store: mock)
        await model.load()
        await mock.setLoadErrorForTest(.unreachable)
        await model.choose("lmstudio/qwen-coder")
        // The Gateway kept the change, so it is not a refusal: the list shows a load error with Retry.
        #expect(await mock.setCalls == ["lmstudio/qwen-coder"])
        #expect(model.refusal == nil)
        #expect(model.chatOnly == nil)
        #expect(model.reloadError == BackendError.unreachable.errorDescription)
        #expect(model.phase.value != nil)
        #expect(model.choosing == nil)

        await mock.setLoadErrorForTest(nil)
        await model.load()
        #expect(model.reloadError == nil)
        #expect(model.phase.value?.defaultRef == "lmstudio/qwen-coder")
    }

    @Test func usageLoadsTheReportFromTheGateway() async {
        let report = UsageReport(
            today: UsageTotals(tokens: 1200, costUsd: 0.42, turns: 3),
            month: UsageTotals(tokens: 50_000, costUsd: 12.75, turns: 88),
            byModel: [UsageModelRow(modelRef: "anthropic/claude-sonnet", subscription: false,
                                    totals: UsageTotals(tokens: 9000, costUsd: 2.5, turns: 20))],
            budgetUsd: 20)
        let model = UsageModel(store: MockModels(choices: Self.twoModels, usageReport: report))
        await model.load()
        #expect(model.phase.value == report)
    }

    @Test func aSubscriptionModelShowsNoCostLine() {
        let metered = UsageView.summary(UsageTotals(tokens: 9000, costUsd: 2.5, turns: 20), subscription: false)
        #expect(metered.components(separatedBy: "\u{00B7}").count == 3)
        let plan = UsageView.summary(UsageTotals(tokens: 400, costUsd: 0, turns: 2), subscription: true)
        #expect(plan.components(separatedBy: "\u{00B7}").count == 2)
        #expect(plan.contains(UsageView.money(0)) == false)
    }
}

private extension MockModels {
    func setLoadErrorForTest(_ error: BackendError?) {
        loadError = error
    }
}
