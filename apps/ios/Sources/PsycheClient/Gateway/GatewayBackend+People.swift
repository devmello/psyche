import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore

// People edits from the phone: merge, split and add (memory.entities.merge, .split, .create), and pausing memory
// capture (memory.pause, read back from memory.status). The Mac sends the same calls from its people screens.

extension GatewayBackend {
    public func searchPeople(query: String) async throws -> [EntityRef] {
        let result = try await call(
            "memory.entities.search",
            .obj(["q": .string(query), "kinds": .array([.string("person")]), "limit": .number(20)]))
        return (result["entities"]?.array ?? []).compactMap { entity in
            guard let id = entity["id"]?.string, let name = entity["name"]?.string else { return nil }
            return EntityRef(id: id, name: name)
        }
    }

    /// Merges `otherID` into `id`, as the Mac does: `ids` are both, `into` is the current person. The Gateway's
    /// surviving entity is what the phone opens next; it falls back to `id` when the reply names none.
    public func mergePerson(id: String, with otherID: String) async throws -> String {
        let result = try await call(
            "memory.entities.merge",
            .obj(["ids": .array([.string(id), .string(otherID)]), "into": .string(id)]),
            key: "entities-merge-\(UUID().uuidString)")
        return result["entity"]?["id"]?.string ?? id
    }

    public func personIdentifiers(id: String) async throws -> [EntityIdentifier] {
        let result = try await call("memory.entities.get", .obj(["id": .string(id)]))
        return (result["identifiers"]?.array ?? []).compactMap { row in
            guard let kind = row["kind"]?.string, let value = row["value"]?.string else { return nil }
            return EntityIdentifier(kind: kind, value: value)
        }
    }

    public func splitPerson(id: String, identifiers: [EntityIdentifier], name: String) async throws -> String {
        let result = try await call(
            "memory.entities.split",
            .obj([
                "id": .string(id),
                "identifiers": .array(identifiers.map { .obj(["kind": .string($0.kind), "value": .string($0.value)]) }),
                "name": .string(name),
            ]),
            key: "entities-split-\(UUID().uuidString)")
        guard let newID = result["entity"]?["id"]?.string else { throw BackendError.refused("Split didn't finish. Try again.") }
        return newID
    }

    public func createPerson(name: String, aliases: [String]) async throws -> String {
        // A nil value is left out of the object, so no aliases field is sent when there are none.
        let aliasList: JSONValue? = aliases.isEmpty ? nil : JSONValue.array(aliases.map { JSONValue.string($0) })
        let result = try await call(
            "memory.entities.create",
            .obj(["kind": .string("person"), "name": .string(name), "aliases": aliasList]),
            key: "entities-create-\(UUID().uuidString)")
        guard let newID = result["entity"]?["id"]?.string else { throw BackendError.refused("Couldn't add that person. Try again.") }
        return newID
    }

    public func memoryPaused() async throws -> Bool {
        let result = try await call("memory.status")
        if case .bool(let paused)? = result["paused"] { return paused }
        return false
    }

    public func setMemoryPaused(_ paused: Bool) async throws -> Bool {
        let result = try await call("memory.pause", .obj(["paused": .bool(paused)]), key: "memory-pause-\(UUID().uuidString)")
        if case .bool(let now)? = result["paused"] { return now }
        return paused
    }
}
