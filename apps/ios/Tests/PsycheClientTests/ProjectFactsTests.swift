import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient
@testable import PsycheFeatures

/// Edit and Forget on a project's fact, through `ProjectModel` over a fake Gateway. The project page
/// (`memoryGateway`) loads ent_p1 with one next-step fact. Nothing here touches the keychain or a prompt.
@MainActor
struct ProjectFactsTests {
    static let fact = MemoryFact(
        id: "fact_n", text: "Next step: Read chapter 4", evidence: [], confirmed: true,
        attribute: "next_step", value: "Read chapter 4")

    /// A live backend whose project page is the memory fixture, plus any handlers the test adds.
    nonisolated func project() async throws -> (GatewayBackend, FakeGateway) {
        let (backend, h) = try await MemorySearchWidgetsTests().live { g in MemorySearchWidgetsTests().memoryGateway(g) }
        return (backend, h.gateway)
    }

    @Test func editingAProjectFactSendsTheProjectIdAndTheOwnersValue() async throws {
        let (backend, gateway) = try await project()
        gateway.on("memory.entities.facts.set") { _ in .success(.object(["fact": .object([:]), "superseded": .null])) }
        let model = ProjectModel(id: "ent_p1", store: backend)
        try await model.edit(Self.fact, value: "Read chapter 5")
        let sent = gateway.received.first { $0.method == "memory.entities.facts.set" }
        #expect(sent?.params?["entityId"]?.string == "ent_p1")
        #expect(sent?.params?["attribute"]?.string == "next_step")
        #expect(sent?.params?["value"]?.string == "Read chapter 5")
        #expect(sent?.params?["source"]?["kind"]?.string == "owner_edit")
        #expect(model.changes == 1)
        #expect(model.notice == nil)
    }

    @Test func forgettingAProjectFactRetractsItByItsId() async throws {
        let (backend, gateway) = try await project()
        gateway.on("memory.entities.facts.retract") { _ in .success(.object(["fact": .object([:])])) }
        let model = ProjectModel(id: "ent_p1", store: backend)
        await model.retract(Self.fact)
        let sent = gateway.received.first { $0.method == "memory.entities.facts.retract" }
        #expect(sent?.params?["factId"]?.string == "fact_n")
        #expect(sent?.params?["source"]?["kind"]?.string == "owner_edit")
        #expect(model.changes == 1)
        #expect(model.notice == nil)
    }

    @Test func aFailedForgetShowsTheGatewaysWordsInTheAlert() async throws {
        let (backend, gateway) = try await project()
        gateway.on("memory.entities.facts.retract") { _ in .failure(WireError(code: "not_found", message: "no such fact")) }
        let model = ProjectModel(id: "ent_p1", store: backend)
        await model.retract(Self.fact)
        #expect(model.notice == BackendError.notFound.errorDescription)
        #expect(model.changes == 0)
    }
}
