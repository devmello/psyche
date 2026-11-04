import Foundation

/// Memory's fixture state.
struct MemoryState: Sendable {
    var snapshot = FixtureData.memory
    var facts = FixtureData.personFacts
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
        let facts = memoryState.facts[id] ?? [MemoryFact(id: id + "-f1", text: person.detail, evidence: ["memory"])]
        return PersonDetail(person: person, facts: facts, recent: FixtureData.personRecent[id] ?? [])
    }

    public func project(id: String) async throws -> ProjectDetail {
        await pause()
        guard let project = memoryState.snapshot.projects.first(where: { $0.id == id }) else { throw BackendError.notFound }
        let ids = FixtureData.projectTodoIDs[id] ?? []
        let todos = memoryState.snapshot.todos.filter { ids.contains($0.id) }
        return ProjectDetail(
            project: project, todos: todos,
            notes: FixtureData.projectNotes[id] ?? [MemoryFact(id: id + "-n1", text: project.detail, evidence: ["memory"])],
            evidence: FixtureData.projectEvidence[id] ?? ["memory"])
    }

    public func confirmFact(personID: String, factID: String) async throws {
        guard let index = memoryState.facts[personID]?.firstIndex(where: { $0.id == factID }) else {
            throw BackendError.notFound
        }
        memoryState.facts[personID]?[index].confirmed = true
        publish(.changed(.memory))
    }

    public func retractFact(personID: String, factID: String) async throws {
        guard memoryState.facts[personID]?.contains(where: { $0.id == factID }) == true else {
            throw BackendError.notFound
        }
        memoryState.facts[personID]?.removeAll { $0.id == factID }
        publish(.changed(.memory))
    }
}

extension FixtureData {
    // MARK: Memory

    public static let memory = MemorySnapshot(
        todos: [
            TodoItem(
                id: "t1", title: "Pay rent", meta: "Fri · Home · $1,850", bucket: .thisWeek, needsYou: true,
                threadID: "thr_bills"),
            TodoItem(
                id: "t2", title: "Send the Q3 summary to Dana", meta: "Thu · Q3 review · in progress",
                bucket: .thisWeek, threadID: "thr_q3"),
            TodoItem(id: "t3", title: "Book a dentist cleaning", meta: "Sat · no project", bucket: .thisWeek),
            TodoItem(
                id: "t7", title: "Approve the second quote", meta: "Nov 12 · Kitchen remodel", bucket: .later),
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

    static let projectTodoIDs: [String: [String]] = ["p1": ["t7"], "p2": ["t2"], "p3": ["t4"]]

    static let projectEvidence: [String: [String]] = [
        "p1": ["mail Oct 30", "notes/kitchen.md"],
        "p2": ["Q3-review-v4.key", "calendar"],
        "p3": ["mail Oct 12", "renters-policy-2026.pdf"],
    ]

    static let projectNotes: [String: [MemoryFact]] = [
        "p1": [
            MemoryFact(id: "p1-n1", text: "You picked the quartz sample.", evidence: ["Quartz sample.jpg"]),
            MemoryFact(id: "p1-n2", text: "Waiting on the contractor's second quote.", evidence: ["mail Oct 30"]),
        ],
        "p2": [
            MemoryFact(id: "p2-n1", text: "Dana wants the summary before Thursday's meeting.", evidence: ["mail Nov 2"]),
            MemoryFact(id: "p2-n2", text: "Deck is at version 4, 18 slides.", evidence: ["Q3-review-v4.key"]),
        ],
        "p3": [MemoryFact(id: "p3-n1", text: "Registration is due November 30.", evidence: ["mail Oct 12"])],
    ]

    static let personFacts: [String: [MemoryFact]] = [
        "pe1": [
            MemoryFact(id: "pe1-f1", text: "Your landlord. Rent is $1,850, due on the 6th.", evidence: ["lease-2026.pdf"], confirmed: true),
            MemoryFact(id: "pe1-f2", text: "Prefers a bank transfer over a check.", evidence: ["mail Oct 28"]),
            MemoryFact(id: "pe1-f3", text: "Lives in Oakland.", evidence: ["mail Aug 3"]),
        ],
        "pe2": [
            MemoryFact(id: "pe2-f1", text: "Your manager on the Q3 review.", evidence: ["calendar"], confirmed: true),
            MemoryFact(id: "pe2-f2", text: "Likes a one-page summary ahead of meetings.", evidence: ["mail Nov 2"]),
        ],
        "pe3": [
            MemoryFact(id: "pe3-f1", text: "Your sister. Lands Tuesday at 6:40 pm.", evidence: ["mail Oct 24"], confirmed: true),
            MemoryFact(id: "pe3-f2", text: "Vegetarian.", evidence: ["chat Oct 24"]),
        ],
        "pe4": [
            MemoryFact(id: "pe4-f1", text: "A friend from college.", evidence: ["memory"]),
            MemoryFact(id: "pe4-f2", text: "Last talked in September about the trip.", evidence: ["messages Sep 14"]),
        ],
    ]

    static let personRecent: [String: [MemoryFact]] = [
        "pe1": [MemoryFact(id: "pe1-r1", text: "Mail Oct 28: asked whether you will renew.", evidence: ["mail Oct 28"])],
        "pe2": [MemoryFact(id: "pe2-r1", text: "Mail Nov 2: moved the review to Thursday.", evidence: ["mail Nov 2"])],
        "pe3": [MemoryFact(id: "pe3-r1", text: "Mail Oct 24: sent flight details.", evidence: ["mail Oct 24"])],
    ]
}
