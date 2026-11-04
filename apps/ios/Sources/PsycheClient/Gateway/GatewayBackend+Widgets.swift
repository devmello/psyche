import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

// Generative-UI widgets over the Gateway: `widgets.get`, `widgets.list { pinned }`, `widgets.act`,
// `widgets.image`. `widget.updated` publishes `.changed(.widgets)` and `.changed(.home)` (see EventMapper):
// the widget views refetch (and re-resolve their bindings) and Home's pinned list reloads. Bindings are
// resolved in GatewayBackend+WidgetBindings.swift.
//
// `JSONValue` here is the wire type; the widget model's own type is spelled `PsycheStore.JSONValue`.
extension GatewayBackend {
    public func widget(id: String) async throws -> WidgetSnapshot {
        let result = try await call("widgets.get", .obj(["widgetIds": .array([.string(id)])]))
        guard let wire = result["widgets"]?.array?.first else { throw BackendError.notFound }
        guard let snapshot = Self.snapshot(await resolvingBindings(wire)) else { throw BackendError.notFound }
        return snapshot
    }

    public func pinnedWidgets() async throws -> [WidgetSnapshot] {
        let result = try await call("widgets.list", .obj(["pinned": .bool(true)]))
        var out: [WidgetSnapshot] = []
        for wire in (result["widgets"]?.array ?? []).prefix(6) {
            if let snapshot = Self.snapshot(await resolvingBindings(wire)) { out.append(snapshot) }
        }
        return out
    }

    public func act(
        widgetID: String, nodeID: String, itemID: String?, action: WidgetAction, values: [String: PsycheStore.JSONValue]
    ) async throws -> WidgetSnapshot? {
        switch action {
        case .open:
            return nil  // Navigation belongs to the app.
        case .tool:
            // The Gateway builds the call from the stored spec; only what the owner typed travels.
            var typed: [String: JSONValue] = [:]
            for (key, value) in values {
                switch value {
                case .string(let s): typed[key] = .string(s)
                case .number(let n): typed[key] = .number(n)
                case .bool(let b): typed[key] = .bool(b)
                default: break
                }
            }
            _ = try await call(
                "widgets.act",
                .obj(["widgetId": .string(widgetID), "nodeId": .string(nodeID), "itemId": itemID.map { .string($0) },
                      "values": typed.isEmpty ? nil : .object(typed)]),
                key: "widget-\(UUID().uuidString)")
            return nil
        case .reply(let text):
            let thread = try await widgetThread(widgetID)
            _ = try await call(
                "chat.send",
                .obj(["threadId": .string(thread), "content": .string(text), "fromWidget": .obj(["widgetId": .string(widgetID)])]),
                key: "widget-\(UUID().uuidString)")
            return nil
        case .answer(let requestID, let chosen):
            let current = try await call("questions.get", .obj(["inputRequestId": .string(requestID)]))
            guard let header = current.at("inputRequest", "questions")?.array?.first?["header"]?.string else { throw BackendError.notFound }
            let answer: JSONValue = chosen.count == 1 ? .string(chosen[0]) : .array(chosen.prefix(4).map { .string($0) })
            _ = try await call(
                "questions.answer", .obj(["inputRequestId": .string(requestID), "answer": .object([header: answer])]),
                key: "answer-\(requestID)")
            return nil
        }
    }

    public func image(widgetID: String, ref: String) async throws -> Data? {
        // Only remote images go through the Gateway; a Library file id is not served here.
        guard ref.hasPrefix("https://") else { return nil }
        guard let result = try? await call("widgets.image", .obj(["widgetId": .string(widgetID), "url": .string(ref)])),
            let encoded = result["bytes"]?.string
        else { return nil }
        return Data(base64Encoded: encoded)
    }

    func widgetThread(_ widgetID: String) async throws -> String {
        let result = try await call("widgets.get", .obj(["widgetIds": .array([.string(widgetID)])]))
        guard let thread = result["widgets"]?.array?.first?["threadId"]?.string else { throw BackendError.notFound }
        return thread
    }

    // MARK: - Mapping

    /// A wire `Widget` as the snapshot the renderer draws. `spec.root` is decoded by the widget model's own
    /// tolerant decoder. Bindings are resolved before this (GatewayBackend+WidgetBindings.swift).
    static func snapshot(_ w: JSONValue) -> WidgetSnapshot? {
        guard let id = w["id"]?.string, let spec = w["spec"], let root = spec["root"], let title = spec["title"]?.string,
            let model = store(root)
        else { return nil }
        let taint = (w["taint"]?.array ?? []).compactMap { source in
            source["sender"]?.string ?? source["origin"]?.string ?? source["sourceKind"]?.string
        }
        return WidgetSnapshot(
            id: id, rev: w["rev"]?.int ?? 1,
            spec: WidgetSpec(
                v: spec["v"]?.int ?? 1, title: title, fallbackText: spec["fallbackText"]?.string ?? title, root: model),
            isLive: w["state"]?.string != "frozen", untrustedSources: taint, pinned: w["pinned"]?.bool ?? false,
            updatedAt: WireFormat.date(w["updatedAt"]?.string) ?? .now)
    }

    /// The wire JSON as the widget model's JSON, by way of its encoding.
    static func store(_ value: JSONValue) -> PsycheStore.JSONValue? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(PsycheStore.JSONValue.self, from: data)
    }
}
