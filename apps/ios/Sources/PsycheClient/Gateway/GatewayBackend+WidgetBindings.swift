import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

// Live bindings (generative-ui-2026 §5.4), resolved the way the desktop's `bound.tsx` does. A node with
// `bind: {source, id, field}` is drawn from the entity it names, so a progress widget keeps moving with no
// stored patches. The phone reads the entity from the Gateway (`tasks.get`, `automations.list`) when it
// loads a widget and writes the result over the node's props; the widget views refetch on `.widgets`.
//
// `tool_call` and `research` nodes are read with `widgets.binding.resolve {widgetId, nodeId}`: the Gateway
// holds the tool call and folds the research progress events, which the phone cannot. The widgets refetch
// on `tool_call.updated` and `research.progress` too. A source that is gone, or a task of another chat,
// renders "Unavailable" like the desktop; a Gateway without the method keeps the stored props.
extension GatewayBackend {
    /// The widget with every resolvable binding applied. Never throws: a failed read leaves stored props.
    func resolvingBindings(_ widget: JSONValue) async -> JSONValue {
        guard let root = widget.at("spec", "root") else { return widget }
        let binds = Self.collectBinds(root)
        guard !binds.isEmpty else { return widget }
        var tasks: [String: JSONValue?] = [:]
        for id in Set(binds.filter { $0.source == "task" || $0.source == "job" }.map(\.id)) {
            let result = await settled { try await self.call("tasks.get", .obj(["taskId": .string(id)])) }
            switch result {
            case .success(let value): tasks[id] = .some(value["task"])
            case .failure(let error): if Self.isNotFound(error) { tasks[id] = .some(nil) }  // else: stays unresolved
            }
        }
        var automations: [JSONValue]?
        if binds.contains(where: { $0.source == "automation" }) {
            automations = await optional { try await self.call("automations.list")["automations"]?.array ?? [] }
        }
        var calls: [String: JSONValue] = [:]
        if let widgetID = widget["id"]?.string {
            for bind in binds where bind.source == "tool_call" || bind.source == "research" {
                guard let nodeID = bind.nodeID, calls[nodeID] == nil else { continue }
                let result = await settled {
                    try await self.call("widgets.binding.resolve", .obj(["widgetId": .string(widgetID), "nodeId": .string(nodeID)]))
                }
                if case .success(let value) = result { calls[nodeID] = value }  // else: stays unresolved
            }
        }
        guard case .object(var obj) = widget, case .object(var spec)? = obj["spec"] else { return widget }
        spec["root"] = Self.resolve(
            root, threadID: widget["threadId"]?.string, tasks: tasks, automations: automations, calls: calls)
        obj["spec"] = .object(spec)
        return .object(obj)
    }

    private static func isNotFound(_ error: any Error) -> Bool {
        (error as? BackendError) == .notFound || "\(error)".contains("not_found")
    }

    struct Bind: Equatable {
        var source: String
        var id: String
        var field: String
        /// The id of the node carrying the bind, which `widgets.binding.resolve` takes.
        var nodeID: String?
    }

    static func collectBinds(_ node: JSONValue) -> [Bind] {
        var out: [Bind] = []
        func walk(_ n: JSONValue, _ depth: Int) {
            guard depth <= 12, case .object(let o) = n else { return }
            if let b = o["bind"], let s = b["source"]?.string, let id = b["id"]?.string, let f = b["field"]?.string {
                out.append(Bind(source: s, id: id, field: f, nodeID: o["id"]?.string))
            }
            for child in o["children"]?.array ?? [] { walk(child, depth + 1) }
            for tab in o["tabs"]?.array ?? [] { for child in tab["children"]?.array ?? [] { walk(child, depth + 1) } }
        }
        walk(node, 0)
        return out
    }

    /// Rewrites every bound node. `tasks[id] == .some(nil)` means the task is gone; a missing key means the
    /// read failed (keep the stored props); `automations == nil` means the same for automations. `calls` holds
    /// each `widgets.binding.resolve` result by node id (tool_call and research); a missing key keeps the props.
    static func resolve(
        _ node: JSONValue, threadID: String?, tasks: [String: JSONValue?], automations: [JSONValue]?,
        calls: [String: JSONValue] = [:]
    ) -> JSONValue {
        guard case .object(var o) = node else { return node }
        if let b = o["bind"], let source = b["source"]?.string, let id = b["id"]?.string, let field = b["field"]?.string {
            let bind = Bind(source: source, id: id, field: field, nodeID: o["id"]?.string)
            if let props = boundProps(o, bind, threadID: threadID, tasks: tasks, automations: automations, calls: calls) {
                o["bind"] = nil
                if props.isEmpty { return unavailable(o) }
                for (key, value) in props { o[key] = value }
            }
        }
        if let children = o["children"]?.array {
            o["children"] = .array(children.map { resolve($0, threadID: threadID, tasks: tasks, automations: automations, calls: calls) })
        }
        if let tabs = o["tabs"]?.array {
            o["tabs"] = .array(tabs.map { tab in
                guard case .object(var t) = tab, let kids = t["children"]?.array else { return tab }
                t["children"] = .array(kids.map { resolve($0, threadID: threadID, tasks: tasks, automations: automations, calls: calls) })
                return .object(t)
            })
        }
        return .object(o)
    }

    /// nil: leave the node as stored. Empty: Unavailable. Otherwise the props to merge over the node.
    private static func boundProps(
        _ node: [String: JSONValue], _ bind: Bind, threadID: String?, tasks: [String: JSONValue?], automations: [JSONValue]?,
        calls: [String: JSONValue]
    ) -> [String: JSONValue]? {
        let isStatus = node["type"]?.string == "status"
        let isStat = node["type"]?.string == "stat"
        func status(_ s: String) -> [String: JSONValue] {
            isStatus ? ["label": .string(statusLabel(s)), "tone": .string(tone(s))] : ["text": .string(statusLabel(s))]
        }
        switch bind.source {
        case "task", "job":
            guard let entry = tasks[bind.id] else { return nil }
            guard let task = entry,
                task["threadId"]?.string == threadID || task.at("specialist", "parentThreadId")?.string == threadID
            else { return [:] }
            let state = task["status"]?.string ?? ""
            let checklist = task["checklist"]?.array ?? []
            switch (bind.source, bind.field) {
            case (_, "status"): return status(state)
            case ("task", "title"): return ["text": .string(task["title"]?.string ?? "")]
            case ("task", "summary"): return ["text": .string(task["summary"]?.string ?? "")]
            case ("task", "steps"):
                return ["items": .array(checklist.enumerated().map { i, c in
                    .object([
                        "id": .string("s\(i)"), "label": .string(c["text"]?.string ?? ""),
                        "state": .string(c["status"]?.string == "completed" ? "done" : c["status"]?.string == "in_progress" ? "active" : "todo"),
                    ])
                })]
            case ("task", "progress"):
                let completed = checklist.filter { $0["status"]?.string == "completed" }.count
                let finished = state == "done"
                if checklist.isEmpty {
                    return finished
                        ? ["value": .number(1), "max": .number(1), "indeterminate": .bool(false)]
                        : ["indeterminate": .bool(state == "running" || state == "queued")]
                }
                return [
                    "value": .number(Double(finished ? checklist.count : completed)), "max": .number(Double(checklist.count)),
                    "indeterminate": .bool(false), "tone": .string(state == "failed" ? "danger" : "neutral"),
                ]
            case ("job", "lastStep"):
                let active = checklist.first { $0["status"]?.string == "in_progress" }?["text"]?.string
                return ["text": .string(active ?? task["summary"]?.string ?? "")]
            default: return nil
            }
        case "automation":
            guard let automations else { return nil }
            guard let a = automations.first(where: { $0["id"]?.string == bind.id }) else { return [:] }
            func text(_ s: String) -> [String: JSONValue] { isStat ? ["value": .string(s)] : ["text": .string(s)] }
            func at(_ iso: String?, _ none: String) -> String {
                guard let date = WireFormat.date(iso) else { return none }
                return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
            }
            let enabled = a["enabled"]?.bool == true
            switch bind.field {
            case "status":
                if enabled, let last = a["lastStatus"]?.string { return status(last) }
                return status(enabled ? "enabled" : "disabled")
            case "nextRun": return text(at(a["nextRunAt"]?.string, String(localized: "Not scheduled", bundle: .module)))
            case "lastRun": return text(at(a["lastRunAt"]?.string, String(localized: "Never", bundle: .module)))
            default: return nil
            }
        case "tool_call", "research":
            guard let nodeID = bind.nodeID, let call = calls[nodeID] else { return nil }
            guard call["available"]?.bool == true else { return [:] }
            let state = call["status"]?.string ?? ""
            switch (bind.source, bind.field) {
            case (_, "status"): return status(state)
            case ("research", "claims"):
                let n = call["claims"]?.int ?? 0
                return isStat ? ["value": .number(Double(n))] : ["text": .string("\(n) \(n == 1 ? "claim" : "claims")")]
            case ("research", "sources"):
                let n = call["sources"]?.int ?? 0
                return isStat ? ["value": .number(Double(n))] : ["text": .string("\(n) \(n == 1 ? "source" : "sources")")]
            case ("research", "progress"):
                return [
                    "value": .number(Double(call["step"]?.int ?? 0)),
                    "max": .number(Double(call["steps"]?.int ?? 7)),
                ]
            default: return nil
            }
        default:
            return nil
        }
    }

    private static func unavailable(_ node: [String: JSONValue]) -> JSONValue {
        let label = node["label"]?.string.flatMap { $0.isEmpty ? nil : "\($0): " } ?? ""
        return .object(["type": .string("text"), "id": node["id"] ?? .string("unavailable"), "text": .string(label + "Unavailable")])
    }

    static func tone(_ status: String) -> String {
        status == "done" || status == "ok" ? "success" : status == "failed" ? "danger" : "neutral"
    }

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "queued": String(localized: "Queued", bundle: .module)
        case "running": String(localized: "Running", bundle: .module)
        case "awaiting_input": String(localized: "Waiting for your answer", bundle: .module)
        case "awaiting_approval": String(localized: "Waiting for your approval", bundle: .module)
        case "paused": String(localized: "Paused", bundle: .module)
        case "done", "ok": String(localized: "Done", bundle: .module)
        case "failed": String(localized: "Failed", bundle: .module)
        case "cancelled": String(localized: "Cancelled", bundle: .module)
        case "pending": String(localized: "Pending", bundle: .module)
        case "uncertain": String(localized: "Done, outcome unknown", bundle: .module)
        case "blocked": String(localized: "Blocked", bundle: .module)
        case "working": String(localized: "Working", bundle: .module)
        case "needs_you": String(localized: "Needs you", bundle: .module)
        case "partial": String(localized: "Partly done", bundle: .module)
        case "enabled": String(localized: "Scheduled", bundle: .module)
        case "disabled": String(localized: "Paused", bundle: .module)
        default: status
        }
    }
}
