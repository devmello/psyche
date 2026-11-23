import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// Edit and Forget on a person's fact, the Gateway's refusal of an edit, and the read-only skills list,
/// over a fake Gateway. Nothing here touches the keychain, Touch ID or a permission prompt.
struct MemoryEditSkillsTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    @Test func editSendsTheOwnersValueAsAnOwnerEdit() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.facts.set") { _ in .success(.object(["fact": .object([:]), "superseded": .null])) }
        }
        try await backend.editFact(personID: "ent_pe1", attribute: "city", value: "Oakland")
        let sent = h.gateway.received.first { $0.method == "memory.entities.facts.set" }
        #expect(sent?.params?["entityId"]?.string == "ent_pe1")
        #expect(sent?.params?["attribute"]?.string == "city")
        #expect(sent?.params?["value"]?.string == "Oakland")
        #expect(sent?.params?["source"]?["kind"]?.string == "owner_edit")
    }

    @Test func aRefusedEditShowsTheGatewaysWords() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.entities.facts.set") { _ in
                .failure(WireError(code: "refused", message: "Sensitive traits can't be set from the phone."))
            }
        }
        do {
            try await backend.editFact(personID: "ent_pe1", attribute: "diet", value: "Vegan")
            Issue.record("a refused edit must throw")
        } catch BackendError.refused(let message) {
            #expect(message == "Sensitive traits can't be set from the phone.")
            #expect(BackendError.refused(message).errorDescription == message)
        }
    }

    @Test func forgetRetractsTheFactByItsId() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.facts.retract") { _ in .success(.object(["fact": .object([:])])) }
        }
        try await backend.retractFact(personID: "ent_pe1", factID: "fact_2")
        let sent = h.gateway.received.first { $0.method == "memory.entities.facts.retract" }
        #expect(sent?.params?["factId"]?.string == "fact_2")
        #expect(sent?.params?["source"]?["kind"]?.string == "owner_edit")
    }

    @Test func aFactKeepsItsAttributeAndRawValueForEdit() {
        let facts = GatewayBackend.facts([
            .object(["id": "fact_1", "attribute": "city", "value": "Oakland", "provenance": "owner"]),
            .object(["id": "fact_2", "value": "Prefers a bank transfer"]),  // no attribute: no Edit
        ])
        #expect(facts.map(\.id) == ["fact_1", "fact_2"])
        #expect(facts[0].attribute == "city" && facts[0].value == "Oakland")
        #expect(facts[1].attribute == nil && facts[1].value == "Prefers a bank transfer")
    }

    @Test func skillsLoadWithTheirNameDescriptionAndOnState() async throws {
        let (backend, h) = try await live { g in
            g.on("skills.list") { _ in
                .success(.object(["skills": .array([
                    .object(["name": "daily-brief", "description": "Morning summary", "enabled": .bool(true), "status": "active"]),
                    .object(["name": "draft-mail", "description": "", "enabled": .bool(false), "status": "disabled"]),
                ])]))
            }
        }
        let skills = try await backend.skills()
        #expect(skills == [
            SkillItem(name: "daily-brief", description: "Morning summary", enabled: true),
            SkillItem(name: "draft-mail", description: "", enabled: false),
        ])
        // Read-only on the phone: no skills write is ever sent.
        #expect(!h.gateway.received.contains { $0.method.hasPrefix("skills.") && $0.method != "skills.list" })
    }

    @Test func aSkillWithoutANameIsLeftOut() {
        let skills = GatewayBackend.skillItems(.object(["skills": .array([
            .object(["description": "No name", "enabled": .bool(true)]),
            .object(["name": "ok-skill", "enabled": .bool(false)]),
        ])]))
        #expect(skills == [SkillItem(name: "ok-skill", description: "", enabled: false)])
    }
}
