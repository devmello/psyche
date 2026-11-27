import Foundation
import Testing

@testable import PsycheBlocks
@testable import PsycheStore

/// A widget refetches on its own topic and on a resync. Home and activity events leave it alone, so a screen with
/// several widgets does not fetch every one of them for each event.
@MainActor
struct WidgetLiveRefreshTests {
    static func eventually(_ ok: () -> Bool) async -> Bool {
        for _ in 0..<300 {
            if ok() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return ok()
    }

    @Test func aWidgetRefetchesForItsOwnTopicAndOnResyncOnly() async {
        let store = FixtureBackend()
        let model = WidgetModel(widgetID: "wdg_interactive", backend: store, surface: .chat, initial: nil)
        await model.load()
        let before = store.reads.count("widget")
        let observing = Task { await model.observe() }
        defer { observing.cancel() }
        try? await Task.sleep(for: .milliseconds(50))

        await store.publish(.changed(.home))
        await store.publish(.changed(.activity))
        try? await Task.sleep(for: .milliseconds(150))
        #expect(store.reads.count("widget") == before)

        await store.publish(.changed(.widgets))
        #expect(await Self.eventually { store.reads.count("widget") == before + 1 })

        await store.publish(.resynced)
        #expect(await Self.eventually { store.reads.count("widget") == before + 2 })
    }
}
