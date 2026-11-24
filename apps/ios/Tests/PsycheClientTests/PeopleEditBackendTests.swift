import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// memory.entities.merge, .split, .create and memory.pause over the fake gateway: the params the phone sends, the
/// survivor it reads back, and the pause state. Nothing touches the keychain or a prompt.
struct PeopleEditBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    func sentParams(_ h: GatewayClientTests.Harness, _ method: String) -> [String: JSONValue] {
        let sent = h.gateway.received.first { $0.method == method }
        guard case .object(let fields)? = sent?.params else { return [:] }
        return fields
    }

    @Test func aMergeSendsBothIdsIntoTheCurrentPerson() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.merge") { _ in .success(.object(["entity": .object(["id": .string("pe1")])])) }
        }
        let survivor = try await backend.mergePerson(id: "pe1", with: "pe9")
        let fields = sentParams(h, "memory.entities.merge")
        #expect(fields["ids"] == .array([.string("pe1"), .string("pe9")]))
        #expect(fields["into"]?.stringValue == "pe1")
        #expect(Set(fields.keys) == ["ids", "into"])
        #expect(survivor == "pe1")
    }

    @Test func aMergeReturnsTheSurvivorTheGatewayNames() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.entities.merge") { _ in .success(.object(["entity": .object(["id": .string("pe7")])])) }
        }
        #expect(try await backend.mergePerson(id: "pe1", with: "pe9") == "pe7")
    }

    @Test func aMergeCarriesAFreshIdempotencyKey() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.merge") { _ in .success(.object(["entity": .object(["id": .string("pe1")])])) }
        }
        _ = try await backend.mergePerson(id: "pe1", with: "pe9")
        _ = try await backend.mergePerson(id: "pe1", with: "pe8")
        let keys = h.gateway.received.filter { $0.method == "memory.entities.merge" }.compactMap(\.idempotencyKey)
        #expect(keys.count == 2 && keys[0] != keys[1])
    }

    @Test func aSplitSendsTheChosenDetailsAndTheNewName() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.split") { _ in .success(.object(["entity": .object(["id": .string("pe-new")])])) }
        }
        let newID = try await backend.splitPerson(
            id: "pe1",
            identifiers: [EntityIdentifier(kind: "email", value: "sam.ortiz@example.com")],
            name: "Sam O.")
        let fields = sentParams(h, "memory.entities.split")
        #expect(Set(fields.keys) == ["id", "identifiers", "name"])
        #expect(fields["id"]?.stringValue == "pe1")
        #expect(fields["name"]?.stringValue == "Sam O.")
        #expect(fields["identifiers"] == .array([.object(["kind": .string("email"), "value": .string("sam.ortiz@example.com")])]))
        #expect(newID == "pe-new")
    }

    @Test func aSplitWithoutANewEntityInTheReplyThrows() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.entities.split") { _ in .success(.object([:])) }
        }
        do {
            _ = try await backend.splitPerson(id: "pe1", identifiers: [EntityIdentifier(kind: "phone", value: "1")], name: "X")
            Issue.record("a split that names no new person must throw")
        } catch BackendError.refused {
            // expected: the sheet shows the refusal instead of navigating nowhere
        }
    }

    @Test func aNewPersonSendsKindNameAndOnlyGivenAliases() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.create") { _ in .success(.object(["entity": .object(["id": .string("pe-9")])])) }
        }
        let id = try await backend.createPerson(name: "Priya Shah", aliases: ["Pri"])
        let fields = sentParams(h, "memory.entities.create")
        #expect(fields["kind"]?.stringValue == "person")
        #expect(fields["name"]?.stringValue == "Priya Shah")
        #expect(fields["aliases"] == .array([.string("Pri")]))
        #expect(id == "pe-9")
    }

    @Test func aNewPersonWithoutAnAliasSendsNoAliasesField() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.entities.create") { _ in .success(.object(["entity": .object(["id": .string("pe-10")])])) }
        }
        _ = try await backend.createPerson(name: "Lee", aliases: [])
        #expect(Set(sentParams(h, "memory.entities.create").keys) == ["kind", "name"])
    }

    @Test func thePauseReadsMemoryStatusAndSendsTheNewState() async throws {
        let (backend, h) = try await live { g in
            g.on("memory.status") { _ in .success(.object(["paused": .bool(true)])) }
            g.on("memory.pause") { _ in .success(.object(["paused": .bool(false)])) }
        }
        #expect(try await backend.memoryPaused() == true)
        let now = try await backend.setMemoryPaused(false)
        #expect(now == false)
        let fields = sentParams(h, "memory.pause")
        #expect(fields["paused"] == .bool(false))
        #expect(Set(fields.keys) == ["paused"])
    }
}
