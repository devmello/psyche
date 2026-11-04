import Foundation

// Memory (§4.5): to-dos, work and people. Owner: the Memory session (I7). Gateway methods:
// memory.upcoming, memory.loops.*, memory.entities.search/get/timeline, memory.catchup.*,
// memory.claims.confirm, memory.entities.facts.retract.

public protocol MemoryBackend: Sendable {
    func memory() async throws -> MemorySnapshot
    func setTodo(id: String, done: Bool) async throws
    func person(id: String) async throws -> PersonDetail
    func project(id: String) async throws -> ProjectDetail
    /// "That's right" on a fact (memory.claims.confirm). The fact stays and is marked confirmed.
    func confirmFact(personID: String, factID: String) async throws
    /// "That's wrong" on a fact (memory.entities.facts.retract). The fact leaves the page.
    func retractFact(personID: String, factID: String) async throws
}

extension MemoryBackend {
    // Additive: a backend that cannot edit facts yet says so, and the page offers "Edit on your Mac".
    public func confirmFact(personID: String, factID: String) async throws {
        throw BackendError.refused("Edit this on your Mac.")
    }

    public func retractFact(personID: String, factID: String) async throws {
        throw BackendError.refused("Edit this on your Mac.")
    }
}

public struct MemoryFact: Sendable, Equatable, Identifiable {
    public var id: String
    public var text: String
    public var evidence: [String]
    /// The owner said "that's right".
    public var confirmed: Bool
    public init(id: String, text: String, evidence: [String], confirmed: Bool = false) {
        self.id = id
        self.text = text
        self.evidence = evidence
        self.confirmed = confirmed
    }
}

public struct PersonDetail: Sendable, Equatable {
    public var person: PersonItem
    public var facts: [MemoryFact]
    public var recent: [MemoryFact]
    public init(person: PersonItem, facts: [MemoryFact], recent: [MemoryFact]) {
        self.person = person
        self.facts = facts
        self.recent = recent
    }
}

public struct ProjectDetail: Sendable, Equatable {
    public var project: ProjectItem
    public var todos: [TodoItem]
    public var notes: [MemoryFact]
    /// Where this page comes from: "mail Oct 30", "notes/kitchen.md".
    public var evidence: [String]
    public init(project: ProjectItem, todos: [TodoItem], notes: [MemoryFact], evidence: [String] = []) {
        self.project = project
        self.todos = todos
        self.notes = notes
        self.evidence = evidence
    }
}

public struct MemorySnapshot: Sendable, Equatable {
    public var todos: [TodoItem]
    public var projects: [ProjectItem]
    public var people: [PersonItem]
    public var leftOff: LeftOff

    public init(todos: [TodoItem], projects: [ProjectItem], people: [PersonItem], leftOff: LeftOff) {
        self.todos = todos
        self.projects = projects
        self.people = people
        self.leftOff = leftOff
    }
}

public struct TodoItem: Sendable, Equatable, Identifiable {
    public enum Bucket: Sendable { case thisWeek, later }

    public var id: String
    public var title: String
    /// "Fri · Home · $1,850".
    public var meta: String
    public var bucket: Bucket
    public var needsYou: Bool
    public var done: Bool
    /// The chat thread this came from, for "Open the thread".
    public var threadID: String?

    public init(
        id: String, title: String, meta: String, bucket: Bucket, needsYou: Bool = false, done: Bool = false,
        threadID: String? = nil
    ) {
        self.threadID = threadID
        self.id = id
        self.title = title
        self.meta = meta
        self.bucket = bucket
        self.needsYou = needsYou
        self.done = done
    }
}

public struct ProjectItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var detail: String
    public var fraction: Double

    public init(id: String, title: String, detail: String, fraction: Double) {
        self.id = id
        self.title = title
        self.detail = detail
        self.fraction = fraction
    }
}

public struct PersonItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var initials: String
    public var detail: String

    public init(id: String, name: String, initials: String, detail: String) {
        self.id = id
        self.name = name
        self.initials = initials
        self.detail = detail
    }
}

public struct LeftOff: Sendable, Equatable {
    public var title: String
    public var text: String
    public var evidence: [String]

    public init(title: String, text: String, evidence: [String]) {
        self.title = title
        self.text = text
        self.evidence = evidence
    }
}

extension MemorySnapshot {
    /// Placeholder content shaped like a loaded snapshot, drawn redacted while the first fetch runs.
    public static let skeleton = MemorySnapshot(
        todos: (1...3).map { TodoItem(id: "skt\($0)", title: "Placeholder to-do title", meta: "Day · Project", bucket: .thisWeek) }
            + (4...5).map { TodoItem(id: "skt\($0)", title: "Placeholder to-do title", meta: "Day · Project", bucket: .later) },
        projects: (1...3).map { ProjectItem(id: "skp\($0)", title: "Placeholder project", detail: "Placeholder detail line", fraction: 0.4) },
        people: (1...4).map { PersonItem(id: "skq\($0)", name: "Placeholder Name", initials: "PN", detail: "Placeholder detail line") },
        leftOff: LeftOff(title: "Placeholder.", text: "Placeholder text for where you left off, on two lines of text.", evidence: ["source"]))
}

extension PersonDetail {
    public static let skeleton = PersonDetail(
        person: PersonItem(id: "skq", name: "Placeholder Name", initials: "PN", detail: "Placeholder detail line"),
        facts: (1...3).map { MemoryFact(id: "skf\($0)", text: "Placeholder fact about this person, on one or two lines.", evidence: ["source"]) },
        recent: [MemoryFact(id: "skr", text: "Placeholder recent note about this person.", evidence: ["source"])])
}

extension ProjectDetail {
    public static let skeleton = ProjectDetail(
        project: ProjectItem(id: "skp", title: "Placeholder project", detail: "Placeholder detail line", fraction: 0.4),
        todos: (1...2).map { TodoItem(id: "skt\($0)", title: "Placeholder to-do title", meta: "Day · Project", bucket: .thisWeek) },
        notes: (1...2).map { MemoryFact(id: "skn\($0)", text: "Placeholder note about this project.", evidence: ["source"]) },
        evidence: ["source", "source"])
}
