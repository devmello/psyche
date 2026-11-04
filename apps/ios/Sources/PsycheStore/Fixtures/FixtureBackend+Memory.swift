import Foundation

/// Memory's fixture state.
struct MemoryState: Sendable {
    var snapshot = FixtureData.memory
}

extension FixtureBackend: MemoryBackend {
    public func memory() async throws -> MemorySnapshot {
        await pause()
        return memoryState.snapshot
    }

    public func setTodo(id: String, done: Bool) async throws {
        guard let index = memoryState.snapshot.todos.firstIndex(where: { $0.id == id }) else {
            throw BackendError.notFound
        }
        memoryState.snapshot.todos[index].done = done
        publish(.changed(.memory))
    }

    public func person(id: String) async throws -> PersonDetail {
        await pause()
        guard let person = memoryState.snapshot.people.first(where: { $0.id == id }) else { throw BackendError.notFound }
        return PersonDetail(
            person: person,
            facts: [MemoryFact(id: id + "-f1", text: person.detail, evidence: ["memory"])],
            recent: [])
    }

    public func project(id: String) async throws -> ProjectDetail {
        await pause()
        guard let project = memoryState.snapshot.projects.first(where: { $0.id == id }) else { throw BackendError.notFound }
        return ProjectDetail(project: project, todos: [], notes: [MemoryFact(id: id + "-n1", text: project.detail, evidence: ["memory"])])
    }
}

extension FixtureData {
    // MARK: Memory

    public static let memory = MemorySnapshot(
        todos: [
            TodoItem(
                id: "t1", title: "Pay rent", meta: "Fri · Home · $1,850", bucket: .thisWeek, needsYou: true),
            TodoItem(
                id: "t2", title: "Send the Q3 summary to Dana", meta: "Thu · Q3 review · in progress",
                bucket: .thisWeek),
            TodoItem(id: "t3", title: "Book a dentist cleaning", meta: "Sat · no project", bucket: .thisWeek),
            TodoItem(id: "t4", title: "Renew car registration", meta: "Nov 30 · Car", bucket: .later),
            TodoItem(id: "t5", title: "Renew renter's insurance", meta: "Dec 1 · Home", bucket: .later),
            TodoItem(
                id: "t6", title: "File the expense report", meta: "Handed in · Oct 31", bucket: .later, done: true),
        ],
        projects: [
            ProjectItem(
                id: "p1", title: "Kitchen remodel", detail: "Waiting on the second quote", fraction: 0.4),
            ProjectItem(id: "p2", title: "Q3 review", detail: "Step 3 of 7", fraction: 3.0 / 7.0),
            ProjectItem(id: "p3", title: "Car", detail: "Registration due Nov 30", fraction: 0.75),
        ],
        people: [
            PersonItem(id: "pe1", name: "Sam Ortiz", initials: "SO", detail: "Landlord · last mail Oct 28"),
            PersonItem(id: "pe2", name: "Dana Reyes", initials: "DR", detail: "Work · Q3 review"),
            PersonItem(id: "pe3", name: "Maya Chen", initials: "MC", detail: "Family · lands Tue 6:40 pm"),
            PersonItem(id: "pe4", name: "Jordan Lee", initials: "JL", detail: "Friend · last talked in September"),
        ],
        leftOff: LeftOff(
            title: "Kitchen remodel.",
            text: "You picked the quartz sample and were waiting on the contractor's second quote.",
            evidence: ["mail Oct 30", "notes/kitchen.md"])
    )
}
