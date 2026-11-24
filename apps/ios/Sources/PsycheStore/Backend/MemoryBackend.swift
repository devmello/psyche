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
    /// The owner's own value for a fact's attribute (memory.entities.facts.set). The Gateway supersedes
    /// the current value and refuses sensitive traits; its message comes back as `BackendError.refused`.
    func editFact(personID: String, attribute: String, value: String) async throws
    /// The workspace files the agent keeps (memory.files.list): read-only on the phone.
    func memoryFiles() async throws -> [MemoryFileRow]
    /// One workspace file's text (memory.read, the whole file).
    func memoryFile(path: String) async throws -> MemoryFileContent
    /// The kind of an entity ("person", "org", "project", "place", …) from memory.entities.get. Throws `.notFound`
    /// when there is no such entity.
    func entityKind(id: String) async throws -> String
    /// Saves the owner's name, aliases, status or due date on a person or project card (memory.entities.update).
    /// A requirement, not only an extension default, so a backend's own edit is the one the sheet reaches.
    func updateEntity(id: String, changes: EntityChanges, ifMatch: String?) async throws
    /// What Psyche learned from the owner, newest first (memory.lessons.list), without forgotten lessons.
    func lessons() async throws -> [LessonItem]
    /// "Keep it" on a lesson (memory.lessons.confirm).
    func confirmLesson(id: String) async throws
    /// The owner's own line for a lesson (memory.lessons.edit).
    func editLesson(id: String, value: String) async throws
    /// Forgets a lesson and restores what it replaced (memory.lessons.forget).
    func forgetLesson(id: String) async throws
    /// Claims Psyche is not sure of and waits on (memory.claims.list).
    func claims() async throws -> [ClaimItem]
    /// "Right" on a claim (memory.claims.confirm): it becomes the owner's.
    func confirmClaim(id: String) async throws
    /// Facts Psyche accepted on its own in the last week (memory.review.list, auto_accepted).
    func recentChanges() async throws -> [RecentChange]
    /// Reverts an automatic change (memory.review.undo).
    func undoChange(factID: String) async throws
    /// Adds the owner's own note to today's daily note (memory.remember).
    func remember(text: String) async throws
    /// Every value a fact's attribute has had, newest first, current and earlier (memory.entities.history with the
    /// attribute). Read when the owner opens "History" on a fact, not on page load.
    func entityHistory(entityID: String, attribute: String) async throws -> [FactVersion]
    /// Other people matching `query` (memory.entities.search, kind person), for the merge picker.
    func searchPeople(query: String) async throws -> [EntityRef]
    /// Merges `otherID` into `id` (memory.entities.merge with `into` the current person). Returns the id of the
    /// entity that survived, which the phone opens next.
    func mergePerson(id: String, with otherID: String) async throws -> String
    /// The contact details a person holds (memory.entities.get identifiers): what a split can move.
    func personIdentifiers(id: String) async throws -> [EntityIdentifier]
    /// Moves `identifiers` off `id` to a new person named `name` (memory.entities.split). Returns the new id.
    func splitPerson(id: String, identifiers: [EntityIdentifier], name: String) async throws -> String
    /// A new person with a name and optional aliases (memory.entities.create). Returns the new id.
    func createPerson(name: String, aliases: [String]) async throws -> String
    /// Whether memory capture is paused (memory.status `paused`).
    func memoryPaused() async throws -> Bool
    /// Pauses or resumes memory capture (memory.pause). Returns the state the Gateway now reports.
    func setMemoryPaused(_ paused: Bool) async throws -> Bool
}

extension MemoryBackend {
    // Additive: a backend without the memory files or entity reads says it has nothing to show.
    public func memoryFiles() async throws -> [MemoryFileRow] { throw BackendError.notFound }
    public func memoryFile(path: String) async throws -> MemoryFileContent { throw BackendError.notFound }
    public func entityKind(id: String) async throws -> String { throw BackendError.notFound }
    // Additive: a backend without the learning surface says it has nothing to show.
    public func lessons() async throws -> [LessonItem] { throw BackendError.notFound }
    public func confirmLesson(id: String) async throws { throw BackendError.notFound }
    public func editLesson(id: String, value: String) async throws { throw BackendError.notFound }
    public func forgetLesson(id: String) async throws { throw BackendError.notFound }
    public func claims() async throws -> [ClaimItem] { throw BackendError.notFound }
    public func confirmClaim(id: String) async throws { throw BackendError.notFound }
    public func recentChanges() async throws -> [RecentChange] { throw BackendError.notFound }
    public func undoChange(factID: String) async throws { throw BackendError.notFound }
    public func remember(text: String) async throws { throw BackendError.notFound }
    public func entityHistory(entityID: String, attribute: String) async throws -> [FactVersion] { throw BackendError.notFound }

    // Additive: a backend that cannot edit facts yet says so, and the page offers "Edit on your Mac".
    public func confirmFact(personID: String, factID: String) async throws {
        throw BackendError.refused("Edit this on your Mac.")
    }

    public func retractFact(personID: String, factID: String) async throws {
        throw BackendError.refused("Edit this on your Mac.")
    }

    public func editFact(personID: String, attribute: String, value: String) async throws {
        throw BackendError.refused("Edit this on your Mac.")
    }

    // Additive: a backend that cannot edit a card yet says so, and the sheet shows the refusal.
    public func updateEntity(id: String, changes: EntityChanges, ifMatch: String?) async throws {
        throw BackendError.refused("Edit this on your Mac.")
    }

    // Additive: a backend without people editing says so; the sheets show the refusal in its words.
    public func searchPeople(query: String) async throws -> [EntityRef] { throw BackendError.notFound }
    public func mergePerson(id: String, with otherID: String) async throws -> String {
        throw BackendError.refused("Merge this on your Mac.")
    }
    public func personIdentifiers(id: String) async throws -> [EntityIdentifier] { throw BackendError.notFound }
    public func splitPerson(id: String, identifiers: [EntityIdentifier], name: String) async throws -> String {
        throw BackendError.refused("Split this on your Mac.")
    }
    public func createPerson(name: String, aliases: [String]) async throws -> String {
        throw BackendError.refused("Add this on your Mac.")
    }
    public func memoryPaused() async throws -> Bool { throw BackendError.notFound }
    public func setMemoryPaused(_ paused: Bool) async throws -> Bool {
        throw BackendError.refused("Pause memory on your Mac.")
    }
}

/// A person a search or a merge names: enough to list and to open.
public struct EntityRef: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// A contact detail a person holds (an email, a phone, a handle). `kind` is the Gateway's identifier kind.
public struct EntityIdentifier: Sendable, Equatable, Hashable, Identifiable {
    public var kind: String
    public var value: String

    public var id: String { "\(kind):\(value)" }

    public init(kind: String, value: String) {
        self.kind = kind
        self.value = value
    }
}

/// Where a fact came from and how sure Psyche is, from the graph fact itself (memory.entities.* facts). "Why do you
/// believe this?" reads it. `evidence` is the quoted span the fact came from: someone else's words when `origin` is
/// `.untrusted`, so it is shown as plain text only.
public struct FactProvenance: Sendable, Equatable {
    public enum Origin: Sendable, Equatable {
        /// The owner's own words or edit.
        case owner
        /// Psyche inferred it (the rule or the model named by `extractor`).
        case agent
        /// Written by someone else (a message, a mail): untrusted text.
        case untrusted
        /// From the owner's data (a contact, a calendar entry, a file).
        case system
    }

    public var origin: Origin
    /// 0 to 1.
    public var confidence: Double?
    /// The quoted span (at most 200 characters), untrusted text.
    public var evidence: String?
    /// Where it was read, as the kind words the Gateway names ("mail", "contacts", "chat"). Raw ids are not shown.
    public var sourceKinds: [String]
    public var firstSeen: Date?
    public var lastSeen: Date?

    public init(
        origin: Origin, confidence: Double? = nil, evidence: String? = nil, sourceKinds: [String] = [],
        firstSeen: Date? = nil, lastSeen: Date? = nil
    ) {
        self.origin = origin
        self.confidence = confidence
        self.evidence = evidence
        self.sourceKinds = sourceKinds
        self.firstSeen = firstSeen
        self.lastSeen = lastSeen
    }
}

/// One value a fact's attribute has had (memory.entities.history). `evidence` is the source and date, as a fact's own
/// evidence line reads them ("mail Oct 28"). The current value is marked; earlier values are kept by the Gateway.
public struct FactVersion: Sendable, Equatable, Identifiable {
    public var id: String
    public var value: String
    public var isCurrent: Bool
    public var evidence: [String]

    public init(id: String, value: String, isCurrent: Bool, evidence: [String] = []) {
        self.id = id
        self.value = value
        self.isCurrent = isCurrent
        self.evidence = evidence
    }
}

public struct MemoryFact: Sendable, Equatable, Identifiable {
    public var id: String
    public var text: String
    public var evidence: [String]
    /// The owner said "that's right".
    public var confirmed: Bool
    /// The Gateway's attribute (`role`, `city`, ...) and its raw value, for "Edit". Nil when unknown.
    public var attribute: String?
    public var value: String?
    /// Where the fact came from, for "Why do you believe this?". Nil when the Gateway sent none of it.
    public var provenance: FactProvenance?
    /// Edit needs the Gateway's attribute: `memory.entities.facts.set` writes one value for one attribute. A fact
    /// without one has no Edit on the phone, and the Mac cannot edit it either. Forget still works.
    public var isEditable: Bool { attribute != nil }

    public init(
        id: String, text: String, evidence: [String], confirmed: Bool = false, attribute: String? = nil, value: String? = nil,
        provenance: FactProvenance? = nil
    ) {
        self.id = id
        self.text = text
        self.evidence = evidence
        self.confirmed = confirmed
        self.attribute = attribute
        self.value = value
        self.provenance = provenance
    }
}

public struct PersonDetail: Sendable, Equatable {
    public var person: PersonItem
    public var facts: [MemoryFact]
    public var recent: [MemoryFact]
    /// The card's name and aliases for the edit sheet. Nil when the Gateway didn't send it (no Edit then).
    public var card: EntityCard?
    public init(person: PersonItem, facts: [MemoryFact], recent: [MemoryFact], card: EntityCard? = nil) {
        self.person = person
        self.facts = facts
        self.recent = recent
        self.card = card
    }
}

public struct ProjectDetail: Sendable, Equatable {
    public var project: ProjectItem
    public var todos: [TodoItem]
    public var notes: [MemoryFact]
    /// Where this page comes from: "mail Oct 30", "notes/kitchen.md".
    public var evidence: [String]
    /// Keep private in Memory: such a project gets no Space (spaces SR10), so its page shows no Space button.
    public var isPrivate: Bool
    /// Name, aliases, status and due date for the edit sheet. Nil when the Gateway didn't send them.
    public var card: EntityCard?
    public init(
        project: ProjectItem, todos: [TodoItem], notes: [MemoryFact], evidence: [String] = [], isPrivate: Bool = false,
        card: EntityCard? = nil
    ) {
        self.project = project
        self.todos = todos
        self.notes = notes
        self.evidence = evidence
        self.isPrivate = isPrivate
        self.card = card
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

/// One row of the memory file list (memory.files.list): the path, its size, and whether an agent write needs an
/// approval (`protected`).
public struct MemoryFileRow: Sendable, Equatable, Identifiable {
    public var path: String
    public var bytes: Int
    public var isProtected: Bool
    public var id: String { path }

    public init(path: String, bytes: Int, isProtected: Bool) {
        self.path = path
        self.bytes = bytes
        self.isProtected = isProtected
    }
}

/// A workspace file's text (memory.read). Plain text: shown as-is, never interpreted as markup.
public struct MemoryFileContent: Sendable, Equatable {
    public var path: String
    public var content: String

    public init(path: String, content: String) {
        self.path = path
        self.content = content
    }
}
