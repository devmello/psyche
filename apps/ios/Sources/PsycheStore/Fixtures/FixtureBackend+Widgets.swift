import Foundation

/// Widget fixture state: every fixture widget by id, a log of what the owner did, and how far the
/// bound task has come. Actions change the widget and publish `.changed(.home)` (the topic enum is
/// the client-core session's; widgets reuse `.home` until it grows a `.widgets` case).
struct WidgetState: Sendable {
    struct Sent: Sendable, Equatable {
        var widgetID: String
        var nodeID: String
        var itemID: String?
        var action: WidgetAction
        var values: [String: JSONValue]
    }

    /// Pinned to Home, most recently pinned first.
    var pinned = ["wdg_bound", "wdg_progress", "wdg_charts"]
    var widgets: [String: WidgetSnapshot] = Dictionary(
        uniqueKeysWithValues: WidgetFixture.all.map { fixture in
            var snapshot = fixture.snapshot
            snapshot.pinned = ["wdg_bound", "wdg_progress", "wdg_charts"].contains(fixture.id)
            return (fixture.id, snapshot)
        })
    var sent: [Sent] = []
    var boundStep = 1
}

extension FixtureBackend: WidgetBackend {
    public func widget(id: String) async throws -> WidgetSnapshot {
        await pause()
        guard let snapshot = widgetState.widgets[id] else { throw BackendError.notFound }
        return snapshot
    }

    public func pinnedWidgets() async throws -> [WidgetSnapshot] {
        await pause()
        return widgetState.pinned.prefix(6).compactMap { widgetState.widgets[$0] }
    }

    public func act(
        widgetID: String, nodeID: String, itemID: String?, action: WidgetAction, values: [String: JSONValue]
    ) async throws -> WidgetSnapshot? {
        await pause()
        guard var snapshot = widgetState.widgets[widgetID] else { throw BackendError.notFound }
        guard snapshot.isLive else { throw BackendError.refused("This widget is frozen.") }
        let node = snapshot.root.find(id: nodeID)

        // The Gateway checks what the owner typed against the stored spec, whatever the client did.
        if case .form(_, let form)? = node {
            for field in form.fields where field.required && field.kind != .toggle {
                let typed = values[field.id]?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if typed.isEmpty { throw BackendError.refused("\(field.label) is required.") }
            }
        }
        if case .tool("send_email", _) = action, let to = values["to"]?.stringValue, !to.contains("@") {
            throw BackendError.refused("“\(to)” doesn't look like an email address.")
        }

        widgetState.sent.append(
            .init(widgetID: widgetID, nodeID: nodeID, itemID: itemID, action: action, values: values))

        switch action {
        case .open:
            return nil
        case .reply(let text):
            snapshot.setLastAction("Sent to the chat: \(text.prefix(80))", tone: "success")
        case .answer:
            snapshot.setLastAction("Answered.", tone: "success")
        case .tool(let name, _):
            if snapshot.id == "wdg_bound", name == "advance_booking" {
                widgetState.boundStep = min(3, widgetState.boundStep + 1)
                snapshot.bindings = WidgetFixture.boundProps(step: widgetState.boundStep)
            } else {
                snapshot.setLastAction("Proposed \(name). Psyche will ask before it runs.", tone: "info")
            }
        }
        snapshot.rev += 1
        snapshot.updatedAt = Date()
        widgetState.widgets[widgetID] = snapshot
        publish(.changed(.home))
        return snapshot
    }

    public func image(widgetID: String, ref: String) async throws -> Data? {
        await pause()
        guard widgetState.widgets[widgetID] != nil else { throw BackendError.notFound }
        return Data(base64Encoded: WidgetFixture.samplePNGBase64)
    }

    /// For tests: what the owner did in widgets so far.
    func sentWidgetActions() -> [WidgetState.Sent] { widgetState.sent }
}

extension WidgetNode {
    /// The first node with this id, depth first (tabs included).
    public func find(id: String) -> WidgetNode? {
        if meta.id == id { return self }
        switch self {
        case .stack(_, let node): return node.children.lazy.compactMap { $0.find(id: id) }.first
        case .grid(_, let node): return node.children.lazy.compactMap { $0.find(id: id) }.first
        case .card(_, let node): return node.children.lazy.compactMap { $0.find(id: id) }.first
        case .tabs(_, let tabs):
            return tabs.lazy.flatMap(\.children).compactMap { $0.find(id: id) }.first
        default: return nil
        }
    }
}

extension WidgetSnapshot {
    /// Append (or update) a status line at the end of a stack root: how a fixture shows that an
    /// action went through. Widgets whose root is not a stack just don't show it.
    fileprivate mutating func setLastAction(_ label: String, tone: String) {
        guard var root = spec.root.objectValue, root["type"]?.stringValue == "stack",
            var children = root["children"]?.arrayValue
        else { return }
        let node: JSONValue = .object([
            "id": .string("last_action"), "type": .string("status"), "label": .string(label), "tone": .string(tone),
        ])
        if let index = children.firstIndex(where: { $0["id"]?.stringValue == "last_action" }) {
            children[index] = node
        } else {
            children.append(node)
        }
        root["children"] = .array(children)
        spec.root = .object(root)
    }
}
