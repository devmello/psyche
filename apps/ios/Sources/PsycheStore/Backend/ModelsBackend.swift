import Foundation

// The default chat model and usage (Settings: Model and Usage). Gateway methods: models.list (read),
// models.setRole (admin only: the Gateway refuses a phone without admin, and that refusal is shown as is),
// usage.summary (read). Everything here is read from the Gateway; nothing is estimated on the phone.

public protocol ModelsBackend: Sendable {
    /// The models the Gateway reports across its providers, and which one is the default (primary) role.
    func modelChoices() async throws -> ModelChoices
    /// Binds the primary role to `ref` (`models.setRole`). Throws `BackendError.refused` with the Gateway's
    /// message when it refuses, for example without admin scope or for a chat-only model.
    func setDefaultModel(_ ref: String) async throws
    /// Tokens, cost and turns from `usage.summary`: today, this month and the last 7 days by model.
    func usage() async throws -> UsageReport
}

public struct ModelChoice: Sendable, Equatable, Identifiable {
    public var id: String { ref }
    /// "provider/model".
    public var ref: String
    /// The provider's label ("Anthropic", "LM Studio").
    public var providerLabel: String
    public init(ref: String, providerLabel: String) {
        self.ref = ref
        self.providerLabel = providerLabel
    }
}

public struct ModelChoices: Sendable, Equatable {
    public var models: [ModelChoice]
    /// The primary role's model, nil when none is set.
    public var defaultRef: String?
    public init(models: [ModelChoice], defaultRef: String?) {
        self.models = models
        self.defaultRef = defaultRef
    }
}

public struct UsageTotals: Sendable, Equatable {
    public var tokens: Int
    public var costUsd: Double
    public var turns: Int
    public init(tokens: Int, costUsd: Double, turns: Int) {
        self.tokens = tokens
        self.costUsd = costUsd
        self.turns = turns
    }
}

public struct UsageModelRow: Sendable, Equatable, Identifiable {
    public var id: String { modelRef }
    public var modelRef: String
    /// A subscription CLI (no per-token cost).
    public var subscription: Bool
    public var totals: UsageTotals
    public init(modelRef: String, subscription: Bool, totals: UsageTotals) {
        self.modelRef = modelRef
        self.subscription = subscription
        self.totals = totals
    }
}

public struct UsageReport: Sendable, Equatable {
    public var today: UsageTotals
    public var month: UsageTotals
    /// The last 7 days by model, most tokens first, as the Gateway orders them.
    public var byModel: [UsageModelRow]
    /// The monthly budget the owner set on the Mac, when they set one.
    public var budgetUsd: Double?
    public init(today: UsageTotals, month: UsageTotals, byModel: [UsageModelRow], budgetUsd: Double?) {
        self.today = today
        self.month = month
        self.byModel = byModel
        self.budgetUsd = budgetUsd
    }
}
