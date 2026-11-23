import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// The default model and usage over a scripted Gateway: what the phone reads, what it sends for a change,
/// and the Gateway's own refusal when a phone without admin tries to change the default.
struct GatewayModelsTests {
    static let providers: JSONValue = .object(["providers": .array([
        .object([
            "id": "anthropic", "label": "Anthropic", "local": .bool(false), "keyConfigured": .bool(true),
            "models": .array([
                .object(["ref": "anthropic/claude-sonnet", "toolCheck": "agent-capable"]),
                .object(["ref": "anthropic/claude-haiku", "toolCheck": "untested"]),
            ]),
        ]),
        .object([
            "id": "lmstudio", "label": "LM Studio", "local": .bool(true), "keyConfigured": .bool(false),
            "models": .array([
                .object(["ref": "lmstudio/qwen-coder", "toolCheck": "chat-only"]),
                .object(["ref": "anthropic/claude-sonnet", "toolCheck": "agent-capable"]),
                .object(["ref": "", "toolCheck": "untested"]),
            ]),
        ]),
    ]), "roles": .object(["primary": "anthropic/claude-sonnet"])])

    static let usage: JSONValue = .object([
        "days": .array([]),
        "today": .object(["tokens": .number(1200), "costUsd": .number(0.42), "turns": .number(3), "byModel": .array([])]),
        "byModel": .array([
            .object(["modelRef": "anthropic/claude-sonnet", "subscription": .bool(false), "tokens": .number(9000),
                     "costUsd": .number(2.5), "turns": .number(20)]),
            .object(["modelRef": "claude-code/sonnet", "subscription": .bool(true), "tokens": .number(400),
                     "costUsd": .number(0), "turns": .number(2)]),
        ]),
        "month": .object(["tokens": .number(50_000), "costUsd": .number(12.75), "turns": .number(88)]),
        "budgetUsd": .null,
        "primary": .string("anthropic/claude-sonnet"),
    ])

    @Test func theModelListIsEveryReportedModelOnceWithTheDefaultRole() async throws {
        let (backend, gateway) = try await live { g in g.on("models.list") { _ in .success(Self.providers) } }
        let choices = try await backend.modelChoices()
        #expect(choices.models == [
            ModelChoice(ref: "anthropic/claude-sonnet", providerLabel: "Anthropic"),
            ModelChoice(ref: "anthropic/claude-haiku", providerLabel: "Anthropic"),
            ModelChoice(ref: "lmstudio/qwen-coder", providerLabel: "LM Studio"),
        ])
        #expect(choices.defaultRef == "anthropic/claude-sonnet")
        #expect(gateway.received.map(\.method).filter { $0.hasPrefix("models.") } == ["models.list"])
    }

    @Test func settingTheDefaultSendsOnlyThePrimaryRoleAndRef() async throws {
        let (backend, gateway) = try await live { g in
            g.on("models.setRole") { _ in .success(.object(["roles": .object(["primary": "lmstudio/qwen-coder"])])) }
        }
        try await backend.setDefaultModel("lmstudio/qwen-coder")
        let sent = gateway.received.filter { $0.method == "models.setRole" }
        #expect(sent.count == 1)
        #expect(sent.first?.params == .object(["role": .string("primary"), "ref": .string("lmstudio/qwen-coder")]))
    }

    @Test func aPhoneWithoutAdminSeesTheGatewaysRefusalAsItIs() async throws {
        let (backend, _) = try await live { g in
            g.on("models.setRole") { _ in .failure(WireError(code: "forbidden", message: "Needs admin access.")) }
        }
        await #expect(throws: BackendError.refused("Needs admin access.")) {
            try await backend.setDefaultModel("anthropic/claude-haiku")
        }
    }

    @Test func aChatOnlyModelRefusalIsShownAsItIs() async throws {
        let (backend, _) = try await live { g in
            g.on("models.setRole") { _ in .failure(WireError(code: "policy_denied", message: "Chat-only models can't run the agent.")) }
        }
        await #expect(throws: BackendError.refused("Chat-only models can't run the agent.")) {
            try await backend.setDefaultModel("lmstudio/qwen-coder")
        }
    }

    @Test func usageReadsTodayMonthAndTheWindowByModelWithANullBudget() async throws {
        let (backend, gateway) = try await live { g in g.on("usage.summary") { _ in .success(Self.usage) } }
        let report = try await backend.usage()
        #expect(report.today == UsageTotals(tokens: 1200, costUsd: 0.42, turns: 3))
        #expect(report.month == UsageTotals(tokens: 50_000, costUsd: 12.75, turns: 88))
        #expect(report.byModel.map(\.modelRef) == ["anthropic/claude-sonnet", "claude-code/sonnet"])
        #expect(report.byModel[1].subscription)
        #expect(report.budgetUsd == nil)
        let params = gateway.received.first { $0.method == "usage.summary" }?.params
        #expect(params?["days"] == .number(7))
        #expect(params?["timeZone"]?.string?.isEmpty == false)
    }

    @Test func aBudgetTheOwnerSetShowsAsTheBudget() {
        let report = GatewayBackend.usageReport(.object(["budgetUsd": .number(20)]))
        #expect(report.budgetUsd == 20)
        #expect(report.byModel.isEmpty)
        #expect(report.today == UsageTotals(tokens: 0, costUsd: 0, turns: 0))
    }

    private func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, FakeGateway) {
        let (backend, harness) = try await GatewayBackendTests().live(configure)
        return (backend, harness.gateway)
    }
}
