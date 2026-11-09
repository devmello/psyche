import SwiftUI
import WidgetKit

/// WidgetKit widgets and the running-task Live Activity (M2-lite: the app drives it locally, no push).
@main
struct PsycheWidgets: WidgetBundle {
    var body: some Widget {
        NeedsYouWidget()
        TaskLiveActivity()
        ChatTurnLiveActivity()
    }
}

struct NeedsYouWidget: Widget {
    struct Entry: TimelineEntry {
        let date: Date
    }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> Entry { Entry(date: .now) }
        func getSnapshot(in context: Context, completion: @escaping @Sendable (Entry) -> Void) {
            completion(Entry(date: .now))
        }
        func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<Entry>) -> Void) {
            completion(Timeline(entries: [Entry(date: .now)], policy: .never))
        }
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "app.psyche.needs-you", provider: Provider()) { _ in
            Text("Psyche")
                .font(.headline)
                .containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("Needs you")
        .description("Approvals and questions waiting for you.")
        .supportedFamilies([.systemSmall])
    }
}
