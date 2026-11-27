import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

// Search over the Gateway: `search.query` for the hits.
extension GatewayBackend {
    public func search(query: String) async throws -> SearchResults {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return SearchResults(hits: []) }
        let result = try await call("search.query", .obj(["query": .string(text), "limit": .number(40)]))
        return SearchResults(hits: (result["hits"]?.array ?? []).compactMap(Self.hit))
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
            return .init(id: id, group: .chatsAndFiles, symbol: "bubble.left", title: title, detail: detail(String(localized: "Chat", bundle: .module)), target: .chat(id: thread))
        case "library":
            return .init(
                id: id, group: .chatsAndFiles, symbol: "doc", title: title, detail: detail(String(localized: "Library", bundle: .module)),
                target: .file(id: id.replacingOccurrences(of: "library:", with: "")))
        case "person":
            // The person page holds what is known; the row says only who it is.
            let entity = id.replacingOccurrences(of: "entity:", with: "")
            return .init(id: id, group: .people, symbol: "person", title: title, detail: String(localized: "Person", bundle: .module), target: .person(id: entity))
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
                    return .init(id: id, group: .todo, symbol: "circle", title: title, detail: String(localized: "To-do", bundle: .module), target: .todo(id: entity))
                case "project":
                    return .init(id: id, group: .chatsAndFiles, symbol: "folder", title: title, detail: detail(String(localized: "Project", bundle: .module)), target: .project(id: entity))
                default: break
                }
            }
            return .init(id: id, group: .chatsAndFiles, symbol: "brain", title: title, detail: detail(String(localized: "Memory", bundle: .module)))
        case "project", "projects":
            // The project's own document: `entity:<id>`.
            let entity = id.replacingOccurrences(of: "entity:", with: "")
            return .init(
                id: id, group: .chatsAndFiles, symbol: "folder", title: title, detail: detail(String(localized: "Project", bundle: .module)), target: .project(id: entity))
        case "task", "tasks":
            // An Activity line collapses onto its task; the route names the task (`/agent/activity/<taskId>`).
            let task = h["route"]?.string.flatMap { route -> String? in
                route.hasPrefix("/agent/activity/") ? String(route.dropFirst("/agent/activity/".count)) : nil
            } ?? id
            return .init(id: id, group: .chatsAndFiles, symbol: "checklist", title: title, detail: detail(String(localized: "Task", bundle: .module)), target: .task(id: task))
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
