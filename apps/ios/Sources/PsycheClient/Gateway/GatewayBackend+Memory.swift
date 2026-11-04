import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

// Memory over the Gateway (docs/design/memory-everything-2026.md, ios-app-2026 §4.5).
//
// - To-dos are tracked work: assignment entities (`memory.entities.search` kinds assignment, the same
//   read the desktop's Work list makes) and the open "I owe" loops (`memory.loops.list`).
//   `memory.upcoming` is birthdays and dated events (the people tier), so it is not read here.
// - Projects and courses carry progress as handed-in assignments over all assignments, read from the
//   `part_of` relations of each project (`memory.entities.get`).
// - People rows show the name, subtitle and last contact only; facts about people appear on the
//   person page and nowhere else.
// - "Where you left off" is the first `memory.catchup.list` line for the Home surface, which the
//   Gateway has already filtered for the owner's privacy tiers.
extension GatewayBackend {
    public func memory() async throws -> MemorySnapshot {
        async let assignments = settled { try await self.entities(kind: "assignment", limit: 100) }
        async let loops = settled { try await self.openLoops() }
        async let projects = settled { try await self.entities(kind: "project", limit: 50) }
        async let people = optional { try await self.entities(kind: "person", limit: 40) }
        async let catchup = optional { try await self.catchUp() }
        let (a, l, p) = await (assignments, loops, projects)
        if case .failure(let error) = a, case .failure = l, case .failure = p { throw error }

        let now = Date.now
        let catchUpItems = await catchup ?? []
        let progress = await self.projectProgress(try? p.get())
        let todos = Self.todos(
            assignments: (try? a.get()) ?? [], loops: (try? l.get()) ?? [], catchUp: catchUpItems,
            projectNames: progress.projectNameByChild, loopProjectNames: Self.names(try? p.get()), now: now)
        let projectRows = (try? p.get() ?? [])?.compactMap { entity in
            progress.byProject[entity["id"]?.string ?? ""].map { Self.projectItem(entity, progress: $0) }
        } ?? []
        let peopleRows = (await people ?? []).filter { $0["isOwner"]?.bool != true && $0["status"]?.string != "merged" }
            .compactMap(Self.personItem)
        let leftOff = catchUpItems.first(where: { $0["resume"] != nil }).flatMap(Self.leftOff)
            ?? catchUpItems.first.flatMap(Self.leftOff)
        return MemorySnapshot(
            todos: todos, projects: projectRows, people: peopleRows,
            leftOff: leftOff ?? LeftOff(title: "Nothing new.", text: "Psyche will say where you left off once there is something to pick up.", evidence: []))
    }

    public func setTodo(id: String, done: Bool) async throws {
        if id.hasPrefix("loop_") {
            _ = try await call(
                "memory.loops.update", .obj(["id": .string(id), "status": .string(done ? "done" : "open")]),
                key: "todo-\(UUID().uuidString)")
            return
        }
        // An assignment can be marked done or handed in; the contract has no way to reopen one.
        guard done else { throw BackendError.refused("Reopen this on your Mac.") }
        _ = try await call(
            "memory.catchup.act", .obj(["entityId": .string(id), "action": "done"]), key: "todo-\(UUID().uuidString)")
    }

    public func person(id: String) async throws -> PersonDetail {
        async let detail = call("memory.entities.get", .obj(["id": .string(id)]))
        async let timeline = optional { try await self.call("memory.entities.timeline", .obj(["entityId": .string(id), "limit": .number(12)])) }
        let (head, rows) = try await (detail, await timeline)
        guard let entity = head["entity"], let entityID = entity["id"]?.string, entity["kind"]?.string == "person" || entity["kind"]?.string == "org" else {
            throw BackendError.notFound
        }
        let facts = Self.facts(head["facts"]?.array ?? [])
        let name = entity["name"]?.string ?? "Someone"
        let person = PersonItem(
            id: entityID, name: name, initials: Self.initials(name),
            detail: Self.personDetail(entity: entity, facts: head["facts"]?.array ?? []))
        let recent = (rows?["rows"]?.array ?? []).prefix(5).compactMap(Self.recentRow)
        return PersonDetail(person: person, facts: facts, recent: Array(recent))
    }

    public func project(id: String) async throws -> ProjectDetail {
        async let detail = call("memory.entities.get", .obj(["id": .string(id)]))
        async let timeline = optional { try await self.call("memory.entities.timeline", .obj(["entityId": .string(id), "limit": .number(12)])) }
        let (head, rows) = try await (detail, await timeline)
        guard let entity = head["entity"], let entityID = entity["id"]?.string else { throw BackendError.notFound }
        let children = Self.children(of: entityID, in: head)
        let facts = (head["facts"]?.array ?? []).filter { Self.workAttributes.contains($0["attribute"]?.string ?? "") }
        let notes = Self.facts(facts)
        let now = Date.now
        var todos = children.map { Self.todo(assignment: $0, project: nil, catchUp: nil, now: now) }
        for loop in head["openLoops"]?.array ?? [] where loop["projectId"]?.string == entityID && loop["direction"]?.string == "i_owe" {
            if let item = Self.todo(loop: loop, projectName: nil, now: now) { todos.append(item) }
        }
        let timelineEvidence = (rows?["rows"]?.array ?? []).compactMap { Self.chipLabel($0["chip"], at: $0["at"]?.string) }
        var evidence: [String] = []
        for label in notes.flatMap(\.evidence) + timelineEvidence where !evidence.contains(label) { evidence.append(label) }
        let item = Self.projectItem(head["entity"]!, progress: Self.progress(children: children, facts: facts))
        return ProjectDetail(project: item, todos: Self.sorted(todos), notes: notes, evidence: Array(evidence.prefix(4)))
    }

    public func confirmFact(personID: String, factID: String) async throws {
        // `memory.claims.confirm` takes a claim from the notes store; a person's facts live in the graph,
        // where "that's right" is a review decision.
        _ = try await call(
            "memory.review.decide", .obj(["factIds": .array([.string(factID)]), "decision": "confirm"]),
            key: "confirm-\(factID)")
    }

    public func retractFact(personID: String, factID: String) async throws {
        _ = try await call(
            "memory.entities.facts.retract", .obj(["factId": .string(factID), "source": .obj(["kind": "owner_edit"])]),
            key: "retract-\(factID)")
    }

    // MARK: - Reads

    func entities(kind: String, limit: Int) async throws -> [JSONValue] {
        let result = try await call(
            "memory.entities.search", .obj(["q": "", "kinds": .array([.string(kind)]), "limit": .number(Double(limit))]))
        return (result["entities"]?.array ?? []).filter { $0["status"]?.string != "archived" && $0["status"]?.string != "merged" }
    }

    func openLoops() async throws -> [JSONValue] {
        let result = try await call(
            "memory.loops.list", .obj(["status": .array(["open"]), "direction": "i_owe", "limit": .number(60)]))
        return result["loops"]?.array ?? []
    }

    func catchUp() async throws -> [JSONValue] {
        let result = try await call("memory.catchup.list", .obj(["surface": "home", "limit": .number(10)]))
        return result["items"]?.array ?? []
    }

    struct Progress: Sendable {
        var done: Int
        var total: Int
        var note: String?
        var fraction: Double { total > 0 ? Double(done) / Double(total) : 0 }
    }

    struct ProjectProgress: Sendable {
        var byProject: [String: Progress] = [:]
        var projectNameByChild: [String: String] = [:]
    }

    /// One `memory.entities.get` per project (at most 10, each optional), for its handed-in count.
    func projectProgress(_ projects: [JSONValue]?) async -> ProjectProgress {
        var out = ProjectProgress()
        let wanted = (projects ?? []).prefix(10)
        let details: [(JSONValue, JSONValue?)] = await withTaskGroup(of: (Int, JSONValue, JSONValue?).self) { group in
            for (index, entity) in wanted.enumerated() {
                group.addTask {
                    let detail = await self.optional { try await self.call("memory.entities.get", .obj(["id": entity["id"] ?? .null])) }
                    return (index, entity, detail)
                }
            }
            var collected: [(Int, JSONValue, JSONValue?)] = []
            for await item in group { collected.append(item) }
            return collected.sorted { $0.0 < $1.0 }.map { ($0.1, $0.2) }
        }
        for (entity, detail) in details {
            guard let id = entity["id"]?.string else { continue }
            guard let detail else { out.byProject[id] = Progress(done: 0, total: 0, note: nil); continue }
            let children = Self.children(of: id, in: detail)
            let facts = (detail["facts"]?.array ?? []).filter { Self.workAttributes.contains($0["attribute"]?.string ?? "") }
            out.byProject[id] = Self.progress(children: children, facts: facts)
            for child in children {
                if let childID = child["id"]?.string, let name = entity["name"]?.string { out.projectNameByChild[childID] = name }
            }
        }
        return out
    }

    // MARK: - Mapping

    static let workAttributes: Set<String> = ["progress", "stopped_at", "next_step", "status", "deadline", "blocked_on"]

    static func names(_ entities: [JSONValue]?) -> [String: String] {
        var out: [String: String] = [:]
        for entity in entities ?? [] { if let id = entity["id"]?.string, let name = entity["name"]?.string { out[id] = name } }
        return out
    }

    static func todos(
        assignments: [JSONValue], loops: [JSONValue], catchUp: [JSONValue], projectNames: [String: String],
        loopProjectNames: [String: String], now: Date
    ) -> [TodoItem] {
        var catchUpByEntity: [String: JSONValue] = [:]
        for item in catchUp { if let id = item["entityId"]?.string { catchUpByEntity[id] = item } }
        var items: [TodoItem] = []
        for assignment in assignments where assignment["isOwner"]?.bool != true {
            guard assignment["workStatus"]?.string != "dropped", let id = assignment["id"]?.string else { continue }
            let line = catchUpByEntity[id]
            let project = projectNames[id] ?? line?.at("parent", "name")?.string
            items.append(todo(assignment: assignment, project: project, catchUp: line, now: now))
        }
        for loop in loops {
            let project = loop["projectId"]?.string.flatMap { loopProjectNames[$0] }
            if let item = todo(loop: loop, projectName: project, now: now) { items.append(item) }
        }
        return sorted(items)
    }

    static func sorted(_ todos: [TodoItem]) -> [TodoItem] {
        // Open first, soonest first; the bucket is already on each item.
        todos.enumerated().sorted { a, b in
            if a.element.done != b.element.done { return !a.element.done }
            return a.offset < b.offset
        }.map(\.element)
    }

    static func todo(assignment a: JSONValue, project: String?, catchUp: JSONValue?, now: Date) -> TodoItem {
        let status = a["workStatus"]?.string
        let handedIn = status == "submitted" || status == "done"
        let due = WireFormat.date(a["dueAt"]?.string)
        var parts: [String] = []
        if handedIn {
            parts.append(status == "submitted" ? "Handed in" : "Done")
        } else if let due {
            parts.append(dueLabel(due, now: now))
        }
        if let project { parts.append(project) }
        if status == "in_progress", !handedIn { parts.append("in progress") }
        let overdue = !handedIn && (due.map { $0 < now } ?? false)
        let resume = catchUp?.at("resume")
        let thread = ["thread", "chat"].contains(resume?.at("open", "kind")?.string ?? "") ? resume?.at("open", "ref")?.string : nil
        return TodoItem(
            id: a["id"]?.string ?? UUID().uuidString, title: a["name"]?.string ?? "Untitled",
            meta: parts.isEmpty ? "No due date" : parts.joined(separator: " · "),
            bucket: bucket(due: handedIn ? nil : due, now: now), needsYou: overdue || catchUp?["ask"]?.bool == true,
            done: handedIn, threadID: thread)
    }

    static func todo(loop l: JSONValue, projectName: String?, now: Date) -> TodoItem? {
        guard let id = l["id"]?.string, let text = l["text"]?.string, l["status"]?.string == "open" else { return nil }
        let due = WireFormat.date(l["dueAt"]?.string)
        var parts: [String] = []
        if let due { parts.append(dueLabel(due, now: now)) }
        if let projectName { parts.append(projectName) }
        return TodoItem(
            id: id, title: text, meta: parts.isEmpty ? "No due date" : parts.joined(separator: " · "),
            bucket: bucket(due: due, now: now), needsYou: due.map { $0 < now } ?? false)
    }

    /// This week: overdue or due within a week. Everything else, and anything undated, is later.
    static func bucket(due: Date?, now: Date) -> TodoItem.Bucket {
        guard let due else { return .later }
        return due <= now.addingTimeInterval(7 * 86_400) ? .thisWeek : .later
    }

    /// "Today", "Tomorrow", "Fri", "Nov 12"; overdue: "Was due Nov 1".
    static func dueLabel(_ due: Date, now: Date, calendar: Calendar = .current) -> String {
        if calendar.isDate(due, inSameDayAs: now) { return "Today" }
        if due < now { return "Was due " + due.formatted(.dateTime.month(.abbreviated).day()) }
        if calendar.isDate(due, inSameDayAs: now.addingTimeInterval(86_400)) { return "Tomorrow" }
        if let days = calendar.dateComponents([.day], from: now, to: due).day, days < 6 {
            return due.formatted(.dateTime.weekday(.abbreviated))
        }
        return due.formatted(.dateTime.month(.abbreviated).day())
    }

    /// The assignments that are part of project `id` (a `part_of` edge from the assignment to the project).
    static func children(of id: String, in detail: JSONValue) -> [JSONValue] {
        let childIDs = Set((detail["edges"]?.array ?? []).compactMap { edge -> String? in
            guard edge["rel"]?.string == "part_of", edge["dst"]?.string == id, edge["retractedAt"] == nil else { return nil }
            return edge["src"]?.string
        })
        return (detail["related"]?.array ?? []).filter {
            guard let childID = $0["id"]?.string else { return false }
            return childIDs.contains(childID) && $0["kind"]?.string == "assignment" && $0["workStatus"]?.string != "dropped"
        }
    }

    static func progress(children: [JSONValue], facts: [JSONValue]) -> Progress {
        let done = children.filter { ["submitted", "done"].contains($0["workStatus"]?.string ?? "") }.count
        let order = ["next_step", "stopped_at", "progress", "status", "blocked_on"]
        let note = order.lazy.compactMap { attribute in
            facts.first { $0["attribute"]?.string == attribute }?["value"]?.string
        }.first
        if children.isEmpty, let value = facts.first(where: { $0["attribute"]?.string == "progress" })?["value"]?.string,
            let match = value.firstMatch(of: /(\d+)\s*(?:of|\/)\s*(\d+)/), let d = Int(match.1), let t = Int(match.2), t > 0
        {
            return Progress(done: d, total: t, note: note)
        }
        return Progress(done: done, total: children.count, note: note)
    }

    static func projectItem(_ entity: JSONValue, progress: Progress) -> ProjectItem {
        var detail: String
        if progress.total > 0 {
            detail = "\(progress.done) of \(progress.total) done"
            if let note = progress.note { detail += " · " + note }
        } else {
            detail = progress.note ?? (entity["projectStatus"]?.string == "paused" ? "Paused" : "No to-dos yet")
        }
        if let due = WireFormat.date(entity["dueAt"]?.string), progress.total == 0 || progress.note == nil {
            detail += (detail.isEmpty ? "" : " · ") + "Due " + due.formatted(.dateTime.month(.abbreviated).day())
        }
        return ProjectItem(
            id: entity["id"]?.string ?? "", title: entity["name"]?.string ?? "Untitled", detail: detail,
            fraction: progress.fraction)
    }

    /// People rows carry the name, the subtitle and the date of the last contact: no facts.
    static func personItem(_ entity: JSONValue) -> PersonItem? {
        guard let id = entity["id"]?.string, let name = entity["name"]?.string else { return nil }
        var parts: [String] = []
        if let subtitle = entity["subtitle"]?.string, !subtitle.isEmpty { parts.append(subtitle) }
        if let last = WireFormat.date(entity["lastInteractionAt"]?.string) {
            parts.append("last contact " + last.formatted(.dateTime.month(.abbreviated).day()))
        }
        return PersonItem(id: id, name: name, initials: initials(name), detail: parts.joined(separator: " · "))
    }

    static func personDetail(entity: JSONValue, facts: [JSONValue]) -> String {
        func value(_ attribute: String) -> String? {
            facts.first { $0["attribute"]?.string == attribute && $0["retractedAt"] == nil }?["value"]?.string
        }
        let parts = [value("relationship_to_owner").map(humanized), value("role") ?? value("title"), value("employer")]
            .compactMap { $0 }
        let last = WireFormat.date(entity["lastInteractionAt"]?.string).map { "last contact " + $0.formatted(.dateTime.month(.abbreviated).day()) }
        return (Array(parts.prefix(2)) + [last].compactMap { $0 }).joined(separator: " · ")
    }

    /// Current facts the owner can read: proposed ones show with "that's right" still to say; discarded and
    /// quarantined ones are not shown.
    static func facts(_ facts: [JSONValue]) -> [MemoryFact] {
        facts.compactMap { fact in
            guard let id = fact["id"]?.string, let value = fact["value"]?.string, fact["retractedAt"] == nil,
                fact["supersededBy"] == nil, !["discarded", "quarantined"].contains(fact["review"]?.string ?? "")
            else { return nil }
            let attribute = fact["attribute"]?.string ?? "note"
            let text = ["note", "preference"].contains(attribute) ? value : "\(attributeLabel(attribute)): \(value)"
            let owner = fact["provenance"]?.string == "owner" || fact["review"]?.string == "edited"
            return MemoryFact(id: id, text: text, evidence: evidence(of: fact), confirmed: owner)
        }
    }

    /// "mail Oct 28", "contacts Nov 1": where the fact was read and when; "you" for the owner's own words.
    static func evidence(of fact: JSONValue) -> [String] {
        let when = (WireFormat.date(fact["observedAt"]?.string) ?? WireFormat.date(fact["recordedAt"]?.string))
            .map { $0.formatted(.dateTime.month(.abbreviated).day()) }
        var labels: [String] = []
        for source in fact["sources"]?.array?.compactMap(\.string) ?? [] {
            guard let word = source.split(separator: ":", maxSplits: 1).first.map(String.init), source.contains(":"),
                !word.hasPrefix("int_"), !word.hasPrefix("lf_")
            else { continue }
            let label = [sourceWord(word), when].compactMap { $0 }.joined(separator: " ")
            if !labels.contains(label) { labels.append(label) }
        }
        if labels.isEmpty { labels.append(fact["provenance"]?.string == "owner" ? ["you", when].compactMap { $0 }.joined(separator: " ") : ["memory", when].compactMap { $0 }.joined(separator: " ")) }
        return labels
    }

    static func attributeLabel(_ attribute: String) -> String {
        attribute == "relationship_to_owner" ? "Relationship" : humanized(attribute)
    }

    static func sourceWord(_ prefix: String) -> String {
        switch prefix {
        case "contact": "contacts"
        default: prefix
        }
    }

    static func chipLabel(_ chip: JSONValue?, at: String?) -> String? {
        guard let source = chip?["source"]?.string else { return nil }
        let date = WireFormat.date(at).map { $0.formatted(.dateTime.month(.abbreviated).day()) }
        return [source, date].compactMap { $0 }.joined(separator: " ")
    }

    static func recentRow(_ row: JSONValue) -> MemoryFact? {
        guard let id = row["id"]?.string, let text = row["text"]?.string else { return nil }
        let evidence = chipLabel(row["chip"], at: row["at"]?.string)
        return MemoryFact(id: id, text: text, evidence: evidence.map { [$0] } ?? [])
    }

    static func leftOff(_ line: JSONValue) -> LeftOff? {
        guard let title = line["title"]?.string else { return nil }
        let text = line.at("resume", "text")?.string ?? line["line"]?.string ?? ""
        let changes = (line["changes"]?.array ?? []).compactMap { chipLabel(.obj(["source": $0["source"]]), at: $0["at"]?.string) }
        var evidence: [String] = []
        for label in changes where !evidence.contains(label) { evidence.append(label) }
        if evidence.isEmpty, let open = line.at("resume", "open", "ref")?.string { evidence = [open] }
        return LeftOff(title: title.hasSuffix(".") ? title : title + ".", text: text, evidence: evidence)
    }
}
