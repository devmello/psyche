import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

struct AutomationBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    static let listed: JSONValue = .object(["automations": .array([
        .object([
            "id": "auto_1", "kind": "cron", "title": "Friday digest", "prompt": "Summarize the week's mail.",
            "schedule": "30 9 * * 5", "timezone": "America/Los_Angeles", "enabled": .bool(true),
            "delivery": .object([:]), "sessionTarget": "main",
        ]),
        .object(["id": "auto_2", "kind": "reminder", "title": "Renew passport", "schedule": "2030-01-02T09:00:00-08:00", "timezone": "UTC", "enabled": .bool(false)]),
    ])])

    @Test func detailReadsTheAutomationFromTheList() async throws {
        let (backend, _) = try await live { g in g.on("automations.list") { _ in .success(Self.listed) } }
        let detail = try await backend.automation(id: "auto_1")
        #expect(detail.kind == "cron")
        #expect(detail.prompt == "Summarize the week's mail.")
        #expect(detail.schedule == "30 9 * * 5")
        #expect(detail.zone.identifier == "America/Los_Angeles")
        #expect(detail.enabled)
        #expect(detail.isFormKind)
    }

    @Test func detailForAnUnknownIdIsNotFound() async throws {
        let (backend, _) = try await live { g in g.on("automations.list") { _ in .success(Self.listed) } }
        await #expect(throws: BackendError.notFound) { try await backend.automation(id: "nope") }
    }

    @Test func createSendsTheFormsFieldsWithAKeyAndReturnsTheId() async throws {
        let (backend, h) = try await live { g in
            g.on("automations.create") { _ in .success(.object(["automation": .object(["id": "auto_9"])])) }
        }
        let create = AutomationCreate(
            kind: "cron", title: "Standup", schedule: "0 9 * * 1-5", prompt: "Draft my standup.",
            timezone: "Europe/Paris", enabled: true)
        let id = try await backend.createAutomation(create)
        #expect(id == "auto_9")
        let sent = h.gateway.received.filter { $0.method == "automations.create" }
        #expect(sent.count == 1)
        #expect(sent.first?.params?["kind"]?.string == "cron")
        #expect(sent.first?.params?["title"]?.string == "Standup")
        #expect(sent.first?.params?["schedule"]?.string == "0 9 * * 1-5")
        #expect(sent.first?.params?["prompt"]?.string == "Draft my standup.")
        #expect(sent.first?.params?["timezone"]?.string == "Europe/Paris")
        #expect(sent.first?.params?["enabled"]?.bool == true)
        #expect(sent.first?.params?["delivery"] == nil)
        #expect(sent.first?.idempotencyKey?.hasPrefix("automation-create-") == true)
    }

    @Test func updateSendsOnlyTheChangedFields() async throws {
        let (backend, h) = try await live { g in g.on("automations.update") { _ in .success(.object(["automation": .object(["id": "auto_1"])])) } }
        try await backend.updateAutomation(id: "auto_1", changes: AutomationChanges(title: "Weekly digest"))
        let sent = h.gateway.received.filter { $0.method == "automations.update" }
        #expect(sent.count == 1)
        let params = sent.first?.params?.object ?? [:]
        #expect(Set(params.keys) == ["automationId", "title"])
        #expect(params["automationId"]?.string == "auto_1")
        #expect(params["title"]?.string == "Weekly digest")
    }

    @Test func updateCarriesEachChangedFieldAndNothingElse() async throws {
        let (backend, h) = try await live { g in g.on("automations.update") { _ in .success(.object(["automation": .object(["id": "auto_1"])])) } }
        try await backend.updateAutomation(
            id: "auto_1", changes: AutomationChanges(prompt: "New prompt", schedule: "PT6H", enabled: false))
        let params = h.gateway.received.first { $0.method == "automations.update" }?.params?.object ?? [:]
        #expect(Set(params.keys) == ["automationId", "prompt", "schedule", "enabled"])
        #expect(params["schedule"]?.string == "PT6H")
        #expect(params["enabled"]?.bool == false)
    }

    @Test func updateWithNothingChangedSendsNothing() async throws {
        let (backend, h) = try await live { g in g.on("automations.update") { _ in .success(.object([:])) } }
        try await backend.updateAutomation(id: "auto_1", changes: AutomationChanges())
        #expect(h.gateway.received.filter { $0.method == "automations.update" }.isEmpty)
    }

    @Test func deleteSendsTheIdOnly() async throws {
        let (backend, h) = try await live { g in g.on("automations.delete") { _ in .success(.object(["ok": .bool(true)])) } }
        try await backend.deleteAutomation(id: "auto_1")
        let sent = h.gateway.received.filter { $0.method == "automations.delete" }
        #expect(sent.count == 1)
        #expect(sent.first?.params?["automationId"]?.string == "auto_1")
    }

    @Test func aRefusedCreateShowsTheGatewaysWords() async throws {
        let (backend, _) = try await live { g in
            g.on("automations.create") { _ in .failure(WireError(code: "forbidden", message: "This phone can't add automations.")) }
        }
        let create = AutomationCreate(kind: "cron", title: "x", schedule: "0 9 * * *", prompt: "x", timezone: "UTC", enabled: true)
        await #expect(throws: BackendError.refused("This phone can't add automations.")) {
            try await backend.createAutomation(create)
        }
    }

    @Test func aRefusedDeleteOfASystemAutomationShowsTheGatewaysWords() async throws {
        let (backend, _) = try await live { g in
            g.on("automations.delete") { _ in .failure(WireError(code: "conflict", message: "Psyche runs this one; it can't be deleted.")) }
        }
        await #expect(throws: BackendError.refused("Psyche runs this one; it can't be deleted.")) {
            try await backend.deleteAutomation(id: "auto_sys")
        }
    }
}
