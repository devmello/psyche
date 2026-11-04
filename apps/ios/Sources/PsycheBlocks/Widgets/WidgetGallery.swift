#if DEBUG
import PsycheDesign
import PsycheStore
import SwiftUI

/// Every widget fixture on one scrolling page, drawn the way chat draws it. Debug builds only; open
/// it with the hidden launch argument `-psycheWidgetGallery YES`. `-psycheWidgetFixture <id>` shows
/// just one (for screenshots). Interactive fixtures run against their own fixture backend.
public struct WidgetGallery: View {
    public static var isRequested: Bool { UserDefaults.standard.bool(forKey: "psycheWidgetGallery") }
    private static var only: String? { UserDefaults.standard.string(forKey: "psycheWidgetFixture") }

    private let backend = FixtureBackend()

    public init() {}

    private var fixtures: [WidgetFixture] {
        if let only = Self.only { WidgetFixture.all.filter { $0.id == only } } else { WidgetFixture.all }
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                PageHeader("Widgets", eyebrow: "\(fixtures.count) fixtures · debug")
                ForEach(fixtures) { fixture in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(fixture.name).font(.psycheMono(.caption)).foregroundStyle(PsycheColor.muted)
                        WidgetView(
                            widgetID: fixture.id, backend: backend,
                            surface: fixture.id.hasPrefix("feed:") ? .feed : .chat)
                    }
                    .id(fixture.id)
                }
            }
            .padding(.horizontal, PsycheMetrics.pagePadding)
            .padding(.vertical, 16)
        }
        .psycheScreen()
        #if canImport(UIKit)
        .task {
            if let directory = WidgetSnapshotter.requestedDirectory { await WidgetSnapshotter.run(directory: directory) }
        }
        #endif
        .environment(\.widgetHandlers, WidgetHandlers(openRoute: { _ in true }, prefillReply: { _ in }))
    }
}
#endif
