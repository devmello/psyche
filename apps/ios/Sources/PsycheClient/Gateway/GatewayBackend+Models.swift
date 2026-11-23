import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// The default chat model and usage (Settings: Model and Usage). `models.list` and `usage.summary` are read
// scopes; `models.setRole` needs admin, so a phone without it gets the Gateway's refusal as `BackendError.refused`
// and the screen shows that message as is. Nothing is cached or estimated on the phone.
extension GatewayBackend {
    public func modelChoices() async throws -> ModelChoices {
        Self.modelChoices(try await call("models.list", .obj([:])))
    }

    public func setDefaultModel(_ ref: String) async throws {
        _ = try await call("models.setRole", .obj(["role": .string("primary"), "ref": .string(ref)]))
    }

    public func usage() async throws -> UsageReport {
        let timeZone = TimeZone.current.identifier
        return Self.usageReport(try await call("usage.summary", .obj(["days": .number(7), "timeZone": .string(timeZone)])))
    }

    // MARK: - Mapping

    /// Every model of every provider, once each, in the Gateway's order, plus the primary role's ref.
    static func modelChoices(_ result: JSONValue) -> ModelChoices {
        var seen = Set<String>()
        var models: [ModelChoice] = []
        for provider in result["providers"]?.array ?? [] {
            let label = provider["label"]?.string ?? provider["id"]?.string ?? ""
            for model in provider["models"]?.array ?? [] {
                guard let ref = model["ref"]?.string, !ref.isEmpty, seen.insert(ref).inserted else { continue }
                models.append(ModelChoice(ref: ref, providerLabel: label))
            }
        }
        return ModelChoices(models: models, defaultRef: result.at("roles", "primary")?.string)
    }

    static func usageReport(_ result: JSONValue) -> UsageReport {
        let byModel = (result["byModel"]?.array ?? []).compactMap { row -> UsageModelRow? in
            guard let ref = row["modelRef"]?.string else { return nil }
            return UsageModelRow(
                modelRef: ref, subscription: row["subscription"]?.bool ?? false, totals: usageTotals(row))
        }
        return UsageReport(
            today: usageTotals(result["today"]), month: usageTotals(result["month"]), byModel: byModel,
            budgetUsd: result["budgetUsd"]?.double)
    }

    static func usageTotals(_ value: JSONValue?) -> UsageTotals {
        UsageTotals(
            tokens: value?["tokens"]?.int ?? 0, costUsd: value?["costUsd"]?.double ?? 0,
            turns: value?["turns"]?.int ?? 0)
    }
}
