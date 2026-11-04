import Foundation

// Generative-UI widgets (docs/design/ios-app-2026.md A7, §5; docs/design/generative-ui-2026.md).
// Owner: the genui session (I8). Gateway methods: widgets.get, widgets.act, widgets.image. Replies,
// answers and `open` actions have their own Gateway methods (chat.send with `fromWidget`,
// questions.answer, navigation); the real backend routes them from `act`, so the renderer has one
// entry point for every control.

public protocol WidgetBackend: Sendable {
    /// The latest snapshot of one widget (`widgets.get`).
    func widget(id: String) async throws -> WidgetSnapshot

    /// A control was used. `nodeID` (and `itemID` for a list row) name the control: for a `tool`
    /// action the Gateway builds the call from the stored spec and only `values`, what the owner
    /// typed, travels. Returns the widget as it is now when the action changed it locally (a fixture,
    /// or a Gateway that already knows), nil when the effect shows up elsewhere (the reply in the
    /// chat, an approval card). Throws `BackendError.refused` with a message the control shows inline.
    func act(
        widgetID: String, nodeID: String, itemID: String?, action: WidgetAction, values: [String: JSONValue]
    ) async throws -> WidgetSnapshot?

    /// The pinned widgets, most recently pinned first (`widgets.list { pinned: true }`), for Home's Pinned
    /// section. At most 6; empty when nothing is pinned. A backend that can't list them says none.
    func pinnedWidgets() async throws -> [WidgetSnapshot]

    /// The bytes of one image a widget shows (`widgets.image`): a remote https URL that is in the
    /// widget's stored spec, or a Library file id. nil when it isn't available (remote images off).
    func image(widgetID: String, ref: String) async throws -> Data?
}

extension WidgetBackend {
    public func pinnedWidgets() async throws -> [WidgetSnapshot] { [] }
}
