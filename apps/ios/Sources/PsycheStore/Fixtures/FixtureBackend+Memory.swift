import Foundation

/// Memory's fixture state.
struct MemoryState: Sendable {
    var snapshot = FixtureData.memory
    /// Person and project facts by entity id: "That's right", "Edit" and "Forget" change these.
    var facts = FixtureData.personFacts.merging(FixtureData.projectNotes) { person, _ in person }
    /// Earlier values per "entity|attribute", newest first (memory.entities.history); the current value is in `facts`.
    var history = FixtureData.factHistory
    /// The edit-sheet card per person and project id, with the etag `updateEntity` checks.
    var cards = FixtureData.entityCards
    /// What Psyche learned, the claims to confirm and the recent changes (FixtureBackend+Learning.swift).
    var learning = LearningState()
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
        return PersonDetail(
            person: person, facts: facts, recent: FixtureData.personRecent[id] ?? [], card: memoryState.cards[id])
    }

    public func project(id: String) async throws -> ProjectDetail {
        await pause()
        guard let project = memoryState.snapshot.projects.first(where: { $0.id == id }) else { throw BackendError.notFound }
        let ids = FixtureData.projectTodoIDs[id] ?? []
        let todos = memoryState.snapshot.todos.filter { ids.contains($0.id) }
        return ProjectDetail(
            project: project, todos: todos,
            notes: memoryState.facts[id] ?? [MemoryFact(id: id + "-n1", text: project.detail, evidence: ["memory"])],
            evidence: FixtureData.projectEvidence[id] ?? ["memory"], card: memoryState.cards[id])
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

    public func editFact(personID: String, attribute: String, value: String) async throws {
        await pause()
        guard let facts = memoryState.facts[personID], let index = facts.firstIndex(where: { $0.attribute == attribute })
        else { throw BackendError.notFound }
        // The value it replaces is kept as an earlier value, as the Gateway keeps superseded facts.
        let old = facts[index]
        let key = Self.historyKey(personID, attribute)
        let earlier = FactVersion(
            id: old.id + "-h\((memoryState.history[key]?.count ?? 0) + 1)", value: old.value ?? old.text, isCurrent: false,
            evidence: old.evidence)
        memoryState.history[key] = [earlier] + (memoryState.history[key] ?? [])
        memoryState.facts[personID]?[index].value = value
        memoryState.facts[personID]?[index].text = value
        memoryState.facts[personID]?[index].evidence = ["you"]
        memoryState.facts[personID]?[index].confirmed = true
        publish(.changed(.memory))
    }

    public func entityHistory(entityID: String, attribute: String) async throws -> [FactVersion] {
        await pause()
        let current = (memoryState.facts[entityID] ?? []).first { $0.attribute == attribute }.map {
            [FactVersion(id: $0.id, value: $0.value ?? $0.text, isCurrent: true, evidence: $0.evidence)]
        } ?? []
        return current + (memoryState.history[Self.historyKey(entityID, attribute)] ?? [])
    }

    static func historyKey(_ entityID: String, _ attribute: String) -> String { "\(entityID)|\(attribute)" }
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
            MemoryFact(
                id: "p1-n2", text: "Waiting on the contractor's second quote.", evidence: ["mail Oct 30"],
                attribute: "next_step", value: "Waiting on the contractor's second quote."),
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
            MemoryFact(id: "pe1-f3", text: "Lives in Oakland.", evidence: ["mail Aug 3"], attribute: "city", value: "Oakland"),
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

    /// Earlier values of the fixture facts that have one, newest first (`MemoryState.history`).
    static let factHistory: [String: [FactVersion]] = [
        "pe1|city": [
            FactVersion(id: "pe1-f3-h1", value: "Berkeley", isCurrent: false, evidence: ["mail Jun 9"]),
            FactVersion(id: "pe1-f3-h2", value: "San Francisco", isCurrent: false, evidence: ["contacts Jan 12"]),
        ],
        "p1|next_step": [
            FactVersion(id: "p1-n2-h1", value: "Pick a countertop sample", isCurrent: false, evidence: ["notes/kitchen.md"]),
            FactVersion(id: "p1-n2-h2", value: "Get the second quote", isCurrent: false, evidence: ["mail Oct 12"]),
        ],
    ]

    static let personRecent: [String: [MemoryFact]] = [
        "pe1": [MemoryFact(id: "pe1-r1", text: "Mail Oct 28: asked whether you will renew.", evidence: ["mail Oct 28"])],
        "pe2": [MemoryFact(id: "pe2-r1", text: "Mail Nov 2: moved the review to Thursday.", evidence: ["mail Nov 2"])],
        "pe3": [MemoryFact(id: "pe3-r1", text: "Mail Oct 24: sent flight details.", evidence: ["mail Oct 24"])],
    ]
}

// MARK: - Memory files, entity kinds and the edit sheet's saves

extension FixtureBackend {
    public func memoryFiles() async throws -> [MemoryFileRow] {
        await pause()
        return FixtureData.memoryFileTexts
            .map { MemoryFileRow(path: $0.key, bytes: $0.value.utf8.count, isProtected: FixtureData.protectedMemoryFiles.contains($0.key)) }
            .sorted { $0.path < $1.path }
    }

    public func memoryFile(path: String) async throws -> MemoryFileContent {
        await pause()
        guard let text = FixtureData.memoryFileTexts[path] else { throw BackendError.notFound }
        return MemoryFileContent(path: path, content: text)
    }

    public func entityKind(id: String) async throws -> String {
        await pause()
        if memoryState.snapshot.people.contains(where: { $0.id == id }) { return "person" }
        if memoryState.snapshot.projects.contains(where: { $0.id == id }) { return "project" }
        throw BackendError.notFound
    }

    public func updateEntity(id: String, changes: EntityChanges, ifMatch: String?) async throws {
        await pause()
        guard var card = memoryState.cards[id] else { throw BackendError.notFound }
        if let ifMatch, ifMatch != card.etag { throw BackendError.refused("This changed on your Mac. Reload and try again.") }
        if let name = changes.name {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { throw BackendError.refused("A name is needed.") }
            card.name = trimmed
            if let index = memoryState.snapshot.people.firstIndex(where: { $0.id == id }) {
                memoryState.snapshot.people[index].name = trimmed
                memoryState.snapshot.people[index].initials = String(
                    trimmed.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased())
            }
            if let index = memoryState.snapshot.projects.firstIndex(where: { $0.id == id }) {
                memoryState.snapshot.projects[index].title = trimmed
            }
        }
        if let aliases = changes.aliases { card.aliases = aliases }
        if let status = changes.projectStatus { card.projectStatus = status }
        switch changes.dueAt {
        case .clear?: card.dueAt = nil
        case .set(let date)?: card.dueAt = date
        case nil: break
        }
        card.etag = "etag-\(id)-\(UUID().uuidString.prefix(6).lowercased())"
        memoryState.cards[id] = card
        publish(.changed(.memory))
    }
}

extension FixtureData {
    static let protectedMemoryFiles: Set<String> = ["SOUL.md"]

    static let memoryFileTexts: [String: String] = [
        "SOUL.md": "# Soul\n\nBe useful without being loud.\nKeep answers short unless I ask for detail.\nAsk before sending anything on my behalf.\n",
        "USER.md": "# About you\n\n- Lives in Oakland.\n- Works on the Q3 review with Dana.\n- Likes a one-page summary before meetings.\n",
        "memory/notes.md": "# Notes\n\n- Kitchen remodel: quartz sample picked, second quote pending.\n- Car registration due Nov 30.\n- Renter's insurance renews Dec 1.\n",
        "memory/2026-11-20.md": "# Nov 20\n\n- Dana moved the Q3 review to Thursday.\n- Sam asked whether you will renew the lease.\n- Maya lands Tuesday at 6:40 pm.\n",
    ]

    /// The cards the edit sheets start from. Dates are in late November 2026.
    static let entityCards: [String: EntityCard] = [
        "pe1": EntityCard(name: "Sam Ortiz", aliases: ["Sam"], etag: "etag-pe1"),
        "pe2": EntityCard(name: "Dana Reyes", aliases: [], etag: "etag-pe2"),
        "pe3": EntityCard(name: "Maya Chen", aliases: ["Maya"], etag: "etag-pe3"),
        "pe4": EntityCard(name: "Jordan Lee", aliases: [], etag: "etag-pe4"),
        "p1": EntityCard(name: "Kitchen remodel", aliases: ["Kitchen"], projectStatus: .active, etag: "etag-p1"),
        "p2": EntityCard(
            name: "Q3 review", aliases: [], projectStatus: .active, dueAt: Date(timeIntervalSince1970: 1_795_737_600), etag: "etag-p2"),
        "p3": EntityCard(
            name: "Car", aliases: [], projectStatus: .paused, dueAt: Date(timeIntervalSince1970: 1_796_000_000), etag: "etag-p3"),
    ]
}
