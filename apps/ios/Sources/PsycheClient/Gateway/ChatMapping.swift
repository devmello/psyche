import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

/// Gateway chat messages -> `ChatItem`s (the Chat screen's rows).
///
/// One message becomes: its text blocks merged into one `.user` / `.assistant` row whose id is the
/// message id (so `chat.delta`, which names the message, lands on it), a `.toolCall` row per
/// `tool_call` block (id = toolCallId), a `.question` row per `question` block, and an `.evidence` row
/// for `sources`. Blocks the phone has no native view for yet (plan, artifact, widget, receipt, …) are
/// skipped here; I4's block renderers pick them up when they exist.
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
        for block in blocks {
            switch block["type"]?.string {
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
            default:
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
