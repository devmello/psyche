import Foundation

// Memory (§4.5): to-dos, work and people. Owner: the Memory session (I7). Gateway methods:
// memory.upcoming, memory.loops.*, memory.entities.search/get/timeline, memory.catchup.*,
// memory.claims.confirm, memory.entities.facts.retract.

public protocol MemoryBackend: Sendable {
    func memory() async throws -> MemorySnapshot
    func setTodo(id: String, done: Bool) async throws
    func person(id: String) async throws -> PersonDetail
    func project(id: String) async throws -> ProjectDetail
}

public struct MemoryFact: Sendable, Equatable, Identifiable {
    public var id: String
    public var text: String
    public var evidence: [String]
    public init(id: String, text: String, evidence: [String]) {
        self.id = id
        self.text = text
        self.evidence = evidence
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
    public init(project: ProjectItem, todos: [TodoItem], notes: [MemoryFact]) {
        self.project = project
        self.todos = todos
        self.notes = notes
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

    public init(id: String, title: String, meta: String, bucket: Bucket, needsYou: Bool = false, done: Bool = false) {
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
    public static let skeleton = MemorySnapshot(
        todos: (1...3).map { TodoItem(id: "skt\($0)", title: "Placeholder to-do title", meta: "Day · Project", bucket: .thisWeek) },
        projects: [], people: [],
        leftOff: LeftOff(title: "Placeholder.", text: "Placeholder text for where you left off, on two lines of text.", evidence: ["source"]))
}
