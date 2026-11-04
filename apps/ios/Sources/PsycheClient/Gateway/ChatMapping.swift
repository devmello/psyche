import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

/// Gateway chat messages -> `ChatItem`s (the Chat screen's rows).
///
/// One message becomes: its text blocks merged into one `.user` / `.assistant` row whose id is the
/// message id (so `chat.delta`, which names the message, lands on it), a `.toolCall` row per
/// `tool_call` block (id = toolCallId), a `.question` row per `question` block, and an `.evidence` row
/// for `sources`, and so on for every block whose row can be drawn from the block alone (`ui` becomes
/// `.widget`, `checklist` a progress list, `file`/`artifact`, `app_link`, `context`, `related_threads`,
/// `wrap_up`, `learned`, `taught`, `compaction`). Blocks that only carry an id of something to fetch
/// (`plan`, `task`, `approval`, `receipt`, `specialist_result`, `automation_workflow`) and types this build
/// has never heard of become `.unknown`, which the Chat screen shows as "Open on your Mac".
enum ChatMapping {
    /// Resolves a `question` block's input request. nil keeps a title-only row.
    typealias QuestionLookup = @Sendable (_ inputRequestID: String) async -> (title: String, options: [ChatOption])?

    static func items(from message: JSONValue, lookupQuestion: QuestionLookup) async -> [ChatItem] {
        guard let id = message["id"]?.string, let role = message["role"]?.string else { return [] }
        let blocks = message["blocks"]?.array ?? []
        // System and tool messages carry no conversation text; their tool_call blocks still show.
        let conversational = role == "user" || role == "agent"
        var out: [ChatItem] = []
        var textIndex: Int?
        var text = ""
        for (index, block) in blocks.enumerated() {
            let type = block["type"]?.string
            // Rows that are not keyed by a Gateway id of their own: message id, position and type are unique.
            let rowID = "\(id)-\(index)-\(type ?? "block")"
            switch type {
            case "text" where conversational:
                let md = block["md"]?.string ?? ""
                if textIndex == nil {
                    textIndex = out.count
                    out.append(placeholder(id: id, role: role))
                    text = md
                } else if !md.isEmpty {
                    text += (text.isEmpty ? "" : "\n\n") + md
                }
            case "tool_call":
                guard let toolID = block["toolCallId"]?.string else { continue }
                let summary = block["level1"]?.string ?? block["tool"]?.string ?? "Tool"
                out.append(.toolCall(id: toolID, symbol: symbol(forTool: block["tool"]?.string ?? ""), summary: summary))
            case "question":
                guard let requestID = block["inputRequestId"]?.string else { continue }
                if let q = await lookupQuestion(requestID) {
                    out.append(.question(id: requestID, title: q.title, options: q.options))
                } else {
                    out.append(.question(id: requestID, title: "Psyche has a question", options: []))
                }
            case "sources":
                let items = block["items"]?.array ?? []
                let parts = items.compactMap { $0["title"]?.string ?? $0["label"]?.string ?? $0["id"]?.string }
                if !parts.isEmpty { out.append(.evidence(id: "\(id)-sources", label: "Sources", parts: parts)) }
            case "text":
                break  // a system or tool message's text carries no conversation
            case "ui":
                guard let widgetID = block["widgetId"]?.string else { continue }
                out.append(.widget(id: rowID, widgetID: widgetID))
            case "checklist":
                let steps = (block["items"]?.array ?? []).enumerated().compactMap { n, item -> ProgressStep? in
                    guard let title = item["text"]?.string else { return nil }
                    let state: ProgressStep.State = switch item["status"]?.string {
                    case "completed": .done
                    case "in_progress": .running
                    default: .pending
                    }
                    return ProgressStep(id: "\(rowID)-\(n)", title: title, state: state)
                }
                if !steps.isEmpty { out.append(.progress(id: rowID, kind: .checklist, title: "Checklist", steps: steps)) }
            case "file":
                guard let itemID = block["libraryItemId"]?.string else { continue }
                out.append(.file(id: rowID, title: "File", fileType: "", detail: "", libraryID: itemID, isArtifact: false))
            case "artifact":
                guard block["artifactId"]?.string != nil else { continue }
                out.append(.file(
                    id: rowID, title: "Artifact", fileType: "", detail: block["preview"]?.string ?? "", libraryID: nil,
                    isArtifact: true))
            case "app_link":
                guard let route = block["route"]?.string else { continue }
                out.append(.appLink(id: rowID, title: "Open in Psyche", detail: route, route: route))
            case "context":
                // Title and source come from fetched content (untrusted): plain text, as `evidence` draws it.
                let parts = [block["title"]?.string, block["source"]?.string].compactMap { $0 }.filter { !$0.isEmpty }
                if !parts.isEmpty { out.append(.evidence(id: rowID, label: "About", parts: parts)) }
            case "related_threads":
                let threads = (block["items"]?.array ?? []).compactMap { item -> RelatedThread? in
                    guard let threadID = item["threadId"]?.string, let title = item["title"]?.string else { return nil }
                    return RelatedThread(id: threadID, title: title, status: item["snippet"]?.string ?? "")
                }
                if !threads.isEmpty { out.append(.relatedThreads(id: rowID, threads: threads)) }
            case "wrap_up":
                guard let recap = block["recap"]?.string else { continue }
                out.append(.note(id: rowID, kind: .wrapUp, title: recap, detail: block["ask"]?.string ?? ""))
            case "learned":
                let facts = (block["items"]?.array ?? []).compactMap { $0["text"]?.string }
                if !facts.isEmpty { out.append(.note(id: rowID, kind: .learned, title: "Learned", detail: facts.joined(separator: "\n"))) }
            case "taught":
                let statement = block["statement"]?.string
                out.append(.note(id: rowID, kind: .taught, title: "Psyche will remember", detail: statement ?? "Thanks. Psyche noted it."))
            case "compaction":
                let turns = block.at("replaced", "turns")?.int ?? 0
                out.append(.note(id: rowID, kind: .compaction, title: "Earlier messages summarized", detail: turns > 0 ? "\(turns) turns" : ""))
            case .some(let other):
                out.append(.unknown(id: rowID, type: other))
            case nil:
                break
            }
        }
        if let textIndex {
            out[textIndex] = role == "user"
                ? .user(id: id, text: text)
                : .assistant(id: id, text: text, streaming: false)
        }
        return out
    }

    private static func placeholder(id: String, role: String) -> ChatItem {
        role == "user" ? .user(id: id, text: "") : .assistant(id: id, text: "", streaming: false)
    }

    /// An SF Symbol for a tool name, from a few families; anything else is a generic gear.
    static func symbol(forTool tool: String) -> String {
        let name = tool.lowercased()
        if name.contains("mail") { return "envelope" }
        if name.contains("search") || name.contains("web") { return "magnifyingglass" }
        if name.contains("calendar") { return "calendar" }
        if name.contains("file") || name.contains("read") || name.contains("write") || name.contains("doc") { return "doc" }
        if name.contains("browser") || name.contains("navigate") { return "safari" }
        if name.contains("exec") || name.contains("shell") || name.contains("bash") { return "terminal" }
        if name.contains("memory") { return "bookmark" }
        return "gearshape"
    }

    static func question(from request: JSONValue) -> (title: String, options: [ChatOption])? {
        guard let first = request["questions"]?.array?.first else { return nil }
        let title = first["question"]?.string ?? "Psyche has a question"
        let options = (first["options"]?.array ?? []).enumerated().compactMap { index, option -> ChatOption? in
            guard let label = option["label"]?.string else { return nil }
            return ChatOption(id: label, title: label, detail: option["description"]?.string ?? "")
        }
        return (title, options)
    }
}
