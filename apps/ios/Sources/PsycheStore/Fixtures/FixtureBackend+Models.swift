import Foundation

/// The default model and usage fixture state.
struct ModelsState: Sendable {
    var defaultRef: String? = "anthropic/claude-sonnet"
    var models: [ModelChoice] = [
        ModelChoice(ref: "anthropic/claude-sonnet", providerLabel: "Anthropic"),
        ModelChoice(ref: "anthropic/claude-haiku", providerLabel: "Anthropic"),
        ModelChoice(ref: "lmstudio/qwen-coder", providerLabel: "LM Studio"),
    ]
}

extension FixtureBackend: ModelsBackend {
    public func modelChoices() async throws -> ModelChoices {
        await pause()
        return ModelChoices(models: modelsState.models, defaultRef: modelsState.defaultRef)
    }

    public func setDefaultModel(_ ref: String) async throws {
        await pause()
        guard modelsState.models.contains(where: { $0.ref == ref }) else { throw BackendError.notFound }
        modelsState.defaultRef = ref
    }

    public func usage() async throws -> UsageReport {
        await pause()
        return FixtureData.usage
    }
}

extension FixtureData {
    public static let usage = UsageReport(
        today: UsageTotals(tokens: 18_400, costUsd: 0.12, turns: 6),
        month: UsageTotals(tokens: 412_000, costUsd: 3.47, turns: 131),
        byModel: [
            UsageModelRow(
                modelRef: "anthropic/claude-sonnet", subscription: false,
                totals: UsageTotals(tokens: 310_000, costUsd: 3.1, turns: 98)),
            UsageModelRow(
                modelRef: "lmstudio/qwen-coder", subscription: false,
                totals: UsageTotals(tokens: 102_000, costUsd: 0, turns: 33)),
        ],
        budgetUsd: 20)
}
