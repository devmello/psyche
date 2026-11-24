import Foundation

// People edits and the memory pause in demo mode (`-psycheScenario live`). Same rules as the Gateway: a merge
// keeps the first person, moves the other's facts and contact details across and drops the other; a split moves
// the chosen details to a new person and keeps at least one here.

extension FixtureBackend {
    public func searchPeople(query: String) async throws -> [EntityRef] {
        await pause()
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return memoryState.snapshot.people
            .filter { needle.isEmpty || $0.name.lowercased().contains(needle) }
            .map { EntityRef(id: $0.id, name: $0.name) }
    }

    public func mergePerson(id: String, with otherID: String) async throws -> String {
        await pause()
        let people = memoryState.snapshot.people.map(\.id)
        guard id != otherID, people.contains(id), people.contains(otherID) else { throw BackendError.notFound }
        let movedFacts = memoryState.facts[otherID] ?? []
        memoryState.facts[id, default: []].append(contentsOf: movedFacts)
        memoryState.facts[otherID] = nil
        memoryState.identifiers[id, default: []].append(contentsOf: memoryState.identifiers[otherID] ?? [])
        memoryState.identifiers[otherID] = nil
        memoryState.snapshot.people.removeAll { $0.id == otherID }
        memoryState.cards[otherID] = nil
        publish(.changed(.memory))
        return id
    }

    public func personIdentifiers(id: String) async throws -> [EntityIdentifier] {
        await pause()
        guard memoryState.snapshot.people.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        return memoryState.identifiers[id] ?? []
    }

    public func splitPerson(id: String, identifiers: [EntityIdentifier], name: String) async throws -> String {
        await pause()
        let held = memoryState.identifiers[id] ?? []
        guard memoryState.snapshot.people.contains(where: { $0.id == id }) else { throw BackendError.notFound }
        guard !identifiers.isEmpty, identifiers.allSatisfy(held.contains), identifiers.count < held.count else {
            throw BackendError.refused("Keep at least one contact detail here.")
        }
        let newID = "pe-\(UUID().uuidString.prefix(8).lowercased())"
        memoryState.identifiers[id] = held.filter { !identifiers.contains($0) }
        memoryState.identifiers[newID] = identifiers
        memoryState.snapshot.people.append(Self.personItem(id: newID, name: name))
        publish(.changed(.memory))
        return newID
    }

    public func createPerson(name: String, aliases: [String]) async throws -> String {
        await pause()
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw BackendError.refused("A name is needed.") }
        let newID = "pe-\(UUID().uuidString.prefix(8).lowercased())"
        memoryState.snapshot.people.append(Self.personItem(id: newID, name: trimmed))
        memoryState.cards[newID] = EntityCard(name: trimmed, aliases: aliases, etag: "etag-\(newID)")
        publish(.changed(.memory))
        return newID
    }

    public func memoryPaused() async throws -> Bool {
        await pause()
        return memoryState.paused
    }

    public func setMemoryPaused(_ paused: Bool) async throws -> Bool {
        await pause()
        memoryState.paused = paused
        publish(.changed(.memory))
        return paused
    }

    static func personItem(id: String, name: String) -> PersonItem {
        let initials = String(name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased())
        return PersonItem(id: id, name: name, initials: initials, detail: "New")
    }
}
