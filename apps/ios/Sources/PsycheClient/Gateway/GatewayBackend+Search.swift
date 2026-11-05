import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

// Search over the Gateway: `search.query` for the hits, `memory.life.answer` for "From your memory"
// when the query reads as a question.
extension GatewayBackend {
    public func search(query: String) async throws -> SearchResults {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return SearchResults(answer: nil, hits: []) }
        let asksQuestion = Self.readsAsQuestion(text)
        async let answer = optional { asksQuestion ? try await self.lifeAnswer(text) : nil }
        let result = try await call("search.query", .obj(["query": .string(text), "limit": .number(40)]))
        var found = await answer ?? nil
        // The Gateway may read a question the rules did not: ask for the answer then.
        if found == nil, !asksQuestion, result.at("understood", "intent")?.string == "answer" {
            found = await optional { try await self.lifeAnswer(text) } ?? nil
        }
        let hits = (result["hits"]?.array ?? []).compactMap(Self.hit)
        return SearchResults(answer: found, hits: hits)
    }

    func lifeAnswer(_ text: String) async throws -> SearchResults.Answer? {
        let result = try await call("memory.life.answer", .obj(["q": .string(text)]))
        guard let sentence = result["answer"]?.string, !sentence.isEmpty else { return nil }
        var evidence: [String] = []
        for fact in result["facts"]?.array ?? [] {
            let when = (WireFormat.date(fact["observedAt"]?.string) ?? WireFormat.date(fact["learnedAt"]?.string))
                .map { $0.formatted(.dateTime.month(.abbreviated).day()) }
            let label = [fact["source"]?.string ?? "memory", when].compactMap { $0 }.joined(separator: " ")
            if !evidence.contains(label) { evidence.append(label) }
        }
        return SearchResults.Answer(text: sentence, emphasis: "", evidence: evidence)
    }

    static func readsAsQuestion(_ text: String) -> Bool {
        if text.hasSuffix("?") { return true }
        let first = text.lowercased().split(separator: " ").first.map(String.init) ?? ""
        return ["when", "what", "who", "whom", "where", "how", "which", "why", "does", "did", "is", "are", "was", "do"].contains(first)
            && text.split(separator: " ").count >= 3
    }

    /// One wire hit as a row. A hit with no app destination keeps its row and has no target.
    static func hit(_ h: JSONValue) -> SearchResults.Hit? {
        guard let id = h["id"]?.string else { return nil }
        let title = h["title"]?.string ?? ""
        let snippet = clipped(h["snippet"]?.string ?? "")
        let date = h["createdAt"]?.double.map { Date(timeIntervalSince1970: $0 / 1000).formatted(.dateTime.month(.abbreviated).day()) }
        func detail(_ label: String) -> String { [label, date, snippet.isEmpty ? nil : snippet].compactMap { $0 }.joined(separator: " · ") }
        let kind = h["kind"]?.string ?? h["scope"]?.string ?? ""
        switch kind {
        case "thread", "message", "threads", "messages":
            let thread = h["threadId"]?.string ?? id
            return .init(id: id, group: .chatsAndFiles, symbol: "bubble.left", title: title, detail: detail("Chat"), target: .chat(id: thread))
        case "library":
            return .init(
                id: id, group: .chatsAndFiles, symbol: "doc", title: title, detail: detail("Library"),
                target: .file(id: id.replacingOccurrences(of: "library:", with: "")))
        case "person":
            // The person page holds what is known; the row says only who it is.
            let entity = id.replacingOccurrences(of: "entity:", with: "")
            return .init(id: id, group: .people, symbol: "person", title: title, detail: "Person", target: .person(id: entity))
        case "memory":
            // The wire hit's `entityType` says which kind of entity it is ("assignment" is a to-do). A Gateway
            // that predates it sends none, so the first line of the document ("To-do: name", "Project: name",
            // see memoryItem in packages/search) is the fallback. Anything else is a note.
            if id.hasPrefix("memory:ent_") {
                let entity = String(id.dropFirst("memory:".count))
                let label = h["entityType"]?.string.map { $0 == "assignment" ? "to-do" : $0 }
                    ?? entityLabel(in: h["snippet"]?.string ?? "")
                switch label {
                case "to-do":
                    return .init(id: id, group: .todo, symbol: "circle", title: title, detail: "To-do", target: .todo(id: entity))
                case "project":
                    return .init(id: id, group: .chatsAndFiles, symbol: "folder", title: title, detail: detail("Project"), target: .project(id: entity))
                default: break
                }
            }
            return .init(id: id, group: .chatsAndFiles, symbol: "brain", title: title, detail: detail("Memory"))
        case "project", "projects":
            // The project's own document: `entity:<id>`.
            let entity = id.replacingOccurrences(of: "entity:", with: "")
            return .init(
                id: id, group: .chatsAndFiles, symbol: "folder", title: title, detail: detail("Project"), target: .project(id: entity))
        case "task", "tasks":
            // An Activity line collapses onto its task; the route names the task (`/agent/activity/<taskId>`).
            let task = h["route"]?.string.flatMap { route -> String? in
                route.hasPrefix("/agent/activity/") ? String(route.dropFirst("/agent/activity/".count)) : nil
            } ?? id
            return .init(id: id, group: .chatsAndFiles, symbol: "checklist", title: title, detail: detail("Task"), target: .task(id: task))
        default:
            return .init(id: id, group: .chatsAndFiles, symbol: "doc.text", title: title, detail: detail(humanized(kind)))
        }
    }

    /// The lowercased label before the first colon of a Memory document's first line, e.g. "to-do".
    private static func entityLabel(in snippet: String) -> String? {
        let first = snippet.drop { $0.isWhitespace || $0.isNewline }
        guard let colon = first.firstIndex(of: ":") else { return nil }
        let label = first[..<colon].lowercased()
        return label.count <= 14 ? label : nil
    }

    private static func clipped(_ text: String) -> String {
        let flat = text.split(whereSeparator: \.isNewline).joined(separator: " ")
        return flat.count > 90 ? String(flat.prefix(90)) + "…" : flat
    }
}
