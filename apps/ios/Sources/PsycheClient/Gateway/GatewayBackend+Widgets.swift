import Foundation
import PsycheStore

// Generative-UI widgets (I8). The renderer is native and merged; mapping `widgets.get` / `widgets.act` /
// `widgets.image` onto it is the next step, so a widget on a live Gateway says it can't load for now
// (the widget frame shows a retry) instead of showing fixture data.
extension GatewayBackend {
    public func widget(id: String) async throws -> WidgetSnapshot { throw BackendError.unreachable }

    public func act(
        widgetID: String, nodeID: String, itemID: String?, action: WidgetAction, values: [String: JSONValue]
    ) async throws -> WidgetSnapshot? { throw BackendError.unreachable }

    public func image(widgetID: String, ref: String) async throws -> Data? { nil }
}
