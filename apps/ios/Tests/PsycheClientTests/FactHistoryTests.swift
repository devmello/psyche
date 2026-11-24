import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient
@testable import PsycheFeatures

/// "History" on a fact: the decode of memory.entities.history, the call it makes, and the sheet's model over a
/// fake Gateway. Nothing here touches the keychain or a prompt.
@MainActor
struct FactHistoryTests {
    static let fact = MemoryFact(
        id: "fact_c", text: "Lives in Oakland.", evidence: ["mail Aug 3"], attribute: "city", value: "Oakland")

    /// One fact as the Gateway's graph returns it (graph.ts GraphFact), with a field the phone doesn't know.
    nonisolated static func version(
        _ id: String, _ value: String, attribute: String = "city", supersededBy: String? = nil, retractedAt: String? = nil,
        review: String? = nil, observedAt: String = "2026-08-03T10:00:00.000Z", source: String = "mail:m1"
    ) -> JSONValue {
        var o: [String: JSONValue] = [
            "id": .string(id), "entityId": "ent_pe1", "attribute": .string(attribute), "value": .string(value),
            "provenance": "extracted", "confidence": .number(0.9), "sources": .array([.string(source)]),
            "evidence": .null, "validFrom": .string(observedAt), "validTo": .null, "recordedAt": .string(observedAt),
            "observedAt": .string(observedAt), "supersededBy": supersededBy.map { JSONValue.string($0) } ?? .null,
            "retractedAt": retractedAt.map { JSONValue.string($0) } ?? .null, "someFutureField": .bool(true),
        ]
        if let review { o["review"] = .string(review) }
        return .object(o)
    }

    /// The Oakland fact (current), and two earlier cities; a retracted, a discarded and a role fact must not show.
    nonisolated static let recorded: JSONValue = .object([
        "facts": .array([
            version("fact_c", "Oakland", supersededBy: nil),
            version("fact_b", "Berkeley", supersededBy: "fact_c", observedAt: "2026-06-09T10:00:00.000Z", source: "mail:m0"),
            version("fact_a", "San Francisco", supersededBy: "fact_b", observedAt: "2026-01-12T10:00:00.000Z", source: "contact:c1"),
            version("fact_x", "Reno", supersededBy: nil, retractedAt: "2026-07-01T10:00:00.000Z"),
            version("fact_d", "Davis", supersededBy: "fact_c", review: "discarded"),
            version("fact_r", "Engineer", attribute: "role", supersededBy: nil),
        ]),
        "edges": .array([.object(["id": "edge_1", "src": "ent_pe1", "dst": "ent_co1", "rel": "works_at"])]),
    ])

    /// A live backend whose Gateway answers `memory.entities.history` with `answer`.
    nonisolated func history(_ answer: Result<JSONValue, WireError>) async throws -> (GatewayBackend, FakeGateway) {
        let (backend, h) = try await MemorySearchWidgetsTests().live { g in
            g.on("memory.entities.history") { _ in answer }
        }
        return (backend, h.gateway)
    }

    @Test func decodeKeepsTheAttributesEarlierValuesNewestFirstAndMarksTheCurrentOne() {
        let facts = Self.recorded["facts"]?.array ?? []
        let versions = GatewayBackend.factVersions(facts, attribute: "city")
        #expect(versions.map(\.value) == ["Oakland", "Berkeley", "San Francisco"])
        #expect(versions.map(\.isCurrent) == [true, false, false])
        #expect(versions.map(\.id) == ["fact_c", "fact_b", "fact_a"])
    }

    @Test func decodeGivesEachVersionItsSourceAndDate() {
        let facts = Self.recorded["facts"]?.array ?? []
        let versions = GatewayBackend.factVersions(facts, attribute: "city")
        #expect(versions[1].evidence == ["mail Jun 9"])
        #expect(versions[2].evidence == ["contacts Jan 12"])
    }

    @Test func decodeOfAnEmptyOrMalformedListIsEmpty() {
        #expect(GatewayBackend.factVersions([], attribute: "city").isEmpty)
        #expect(GatewayBackend.factVersions([.object(["value": "no id"])], attribute: "city").isEmpty)
    }

    @Test func theBackendSendsTheEntityAndAttributeAndDecodesTheFacts() async throws {
        let (backend, gateway) = try await history(.success(Self.recorded))
        let versions = try await backend.entityHistory(entityID: "ent_pe1", attribute: "city")
        #expect(versions.map(\.value) == ["Oakland", "Berkeley", "San Francisco"])
        let sent = gateway.received.first { $0.method == "memory.entities.history" }
        #expect(sent?.params?["entityId"]?.string == "ent_pe1")
        #expect(sent?.params?["attribute"]?.string == "city")
    }

    @Test func theSheetModelLoadsTheHistoryOfItsFact() async throws {
        let (backend, _) = try await history(.success(Self.recorded))
        let model = FactHistoryModel(entityID: "ent_pe1", fact: Self.fact, store: backend)
        await model.load()
        #expect(model.phase.value?.map(\.value) == ["Oakland", "Berkeley", "San Francisco"])
    }

    @Test func aFailedLoadShowsThePhaseAsFailedWithTheGatewaysWords() async throws {
        let (backend, _) = try await history(.failure(WireError(code: "not_found", message: "no such entity")))
        let model = FactHistoryModel(entityID: "ent_pe1", fact: Self.fact, store: backend)
        await model.load()
        guard case .failed(let message) = model.phase else {
            Issue.record("expected a failed phase, got \(model.phase)")
            return
        }
        #expect(message == BackendError.notFound.errorDescription)
    }

    @Test func aFactWithoutAnAttributeHasNoHistoryAndAsksTheGatewayForNothing() async throws {
        let (backend, gateway) = try await history(.success(Self.recorded))
        let plain = MemoryFact(id: "fact_p", text: "Prefers a bank transfer.", evidence: [])
        let model = FactHistoryModel(entityID: "ent_pe1", fact: plain, store: backend)
        await model.load()
        #expect(model.phase.value == [])
        #expect(gateway.received.contains { $0.method == "memory.entities.history" } == false)
    }

    @Test func thePersonPageDoesNotLoadHistoryUntilTheOwnerOpensIt() async throws {
        let (backend, gateway) = try await personPage()
        let model = PersonModel(id: "ent_pe1", store: backend)
        await model.load()
        #expect(model.phase.value != nil)
        #expect(gateway.received.contains { $0.method == "memory.entities.history" } == false)
    }

    /// The person page's Gateway (the memory fixture) plus a history handler, so a load that calls it would show.
    nonisolated func personPage() async throws -> (GatewayBackend, FakeGateway) {
        let answer = Self.recorded
        let (backend, h) = try await MemorySearchWidgetsTests().live { g in
            MemorySearchWidgetsTests().memoryGateway(g)
            g.on("memory.entities.history") { _ in .success(answer) }
        }
        return (backend, h.gateway)
    }
}
