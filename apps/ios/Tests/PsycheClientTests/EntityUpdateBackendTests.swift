import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// memory.entities.update over the fake gateway: only the changed fields are sent, the etag is the if-match,
/// and the Gateway's refusal reaches the owner in its own words. Nothing touches the keychain or a prompt.
struct EntityUpdateBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    func sentFields(_ h: GatewayClientTests.Harness) -> [String: JSONValue] {
        let sent = h.gateway.received.first { $0.method == "memory.entities.update" }
        guard case .object(let fields)? = sent?.params else { return [:] }
        return fields
    }

    @Test func aRenameSendsOnlyTheNameIdAndIfMatch() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.update") { _ in .success(.object(["entity": .object([:])])) }
        }
        try await backend.updateEntity(id: "ent_pe1", changes: EntityChanges(name: "Ada King"), ifMatch: "etag-1")
        let fields = sentFields(h)
        #expect(Set(fields.keys) == ["id", "name", "etag"])
        #expect(fields["id"]?.stringValue == "ent_pe1")
        #expect(fields["name"]?.stringValue == "Ada King")
        #expect(fields["etag"]?.stringValue == "etag-1")
    }

    @Test func anAliasEditSendsTheWholeNewList() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.update") { _ in .success(.object(["entity": .object([:])])) }
        }
        try await backend.updateEntity(id: "ent_pe1", changes: EntityChanges(aliases: ["Ada", "Countess"]), ifMatch: nil)
        let fields = sentFields(h)
        #expect(Set(fields.keys) == ["id", "aliases"])
        #expect(fields["aliases"] == .array([.string("Ada"), .string("Countess")]))
    }

    @Test func aStatusAndClearedDueDateSendNullForTheDate() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.update") { _ in .success(.object(["entity": .object([:])])) }
        }
        try await backend.updateEntity(
            id: "ent_p1", changes: EntityChanges(projectStatus: .paused, dueAt: .clear), ifMatch: "etag-2")
        let fields = sentFields(h)
        #expect(Set(fields.keys) == ["id", "projectStatus", "dueAt", "etag"])
        #expect(fields["projectStatus"]?.stringValue == "paused")
        #expect(fields["dueAt"] == .null)
    }

    @Test func aSetDueDateSendsUTCISOWithTheZone() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.update") { _ in .success(.object(["entity": .object([:])])) }
        }
        // 2027-01-15T08:00:00Z
        try await backend.updateEntity(
            id: "ent_p1", changes: EntityChanges(dueAt: .set(Date(timeIntervalSince1970: 1_800_000_000))), ifMatch: nil)
        #expect(sentFields(h)["dueAt"]?.stringValue == "2027-01-15T08:00:00Z")
    }

    @Test func aRefusedEditShowsTheGatewaysWords() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.entities.update") { _ in
                .failure(WireError(code: "refused", message: "That card changed on another device. Reopen it and try again."))
            }
        }
        do {
            try await backend.updateEntity(id: "ent_p1", changes: EntityChanges(name: "X"), ifMatch: "old")
            Issue.record("a refused edit must throw")
        } catch BackendError.refused(let message) {
            #expect(message == "That card changed on another device. Reopen it and try again.")
        }
    }

    @Test func eachSaveCarriesAFreshIdempotencyKey() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.update") { _ in .success(.object(["entity": .object([:])])) }
        }
        try await backend.updateEntity(id: "ent_pe1", changes: EntityChanges(name: "A"), ifMatch: nil)
        try await backend.updateEntity(id: "ent_pe1", changes: EntityChanges(name: "B"), ifMatch: nil)
        let keys = h.gateway.received.filter { $0.method == "memory.entities.update" }.compactMap(\.idempotencyKey)
        #expect(keys.count == 2 && keys[0] != keys[1])
    }

    @Test func theCardComesFromTheEntityAndItsEtag() {
        let card = GatewayBackend.card(
            .object([
                "name": "Launch", "aliases": .array([.string("LCH"), .number(3)]), "projectStatus": "paused",
                "dueAt": "2027-01-15T08:00:00Z",
            ]),
            etag: "etag-9")
        #expect(card == EntityCard(
            name: "Launch", aliases: ["LCH"], projectStatus: .paused,
            dueAt: Date(timeIntervalSince1970: 1_800_000_000), etag: "etag-9"))
    }

    @Test func aCardWithoutANameIsNotOffered() {
        #expect(GatewayBackend.card(.object(["aliases": .array([])]), etag: "e") == nil)
    }
}
