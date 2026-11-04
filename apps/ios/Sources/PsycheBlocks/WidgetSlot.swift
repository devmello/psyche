import PsycheStore
import SwiftUI

/// A generative-UI widget (`ui` block): the native renderer (I8) over `widgets.get`, drawn in its own
/// host frame. Takes only the widget id; the backend comes from the environment.
struct WidgetSlot: View {
    let widgetID: String
    @Environment(\.widgetBackend) private var backend

    var body: some View {
        WidgetView(widgetID: widgetID, backend: backend)
    }
}
