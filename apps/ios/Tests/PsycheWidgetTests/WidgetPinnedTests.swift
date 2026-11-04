import Foundation
import Testing

@testable import PsycheBlocks
@testable import PsycheStore

struct WidgetPinnedTests {
    let store = FixtureBackend()

    @Test func pinnedWidgetsComeBackMostRecentFirstAndFlagged() async throws {
        let pinned = try await store.pinnedWidgets()
        #expect(pinned.map(\.id) == ["wdg_bound", "wdg_progress", "wdg_charts"])
        #expect(pinned.allSatisfy { $0.pinned })
        #expect(pinned.count <= 6)
    }

    @Test func aBackendThatCannotListPinsSaysNone() async throws {
        struct Bare: WidgetBackend {
            func widget(id: String) async throws -> WidgetSnapshot { throw BackendError.notFound }
            func act(widgetID: String, nodeID: String, itemID: String?, action: WidgetAction, values: [String: JSONValue]) async throws -> WidgetSnapshot? { nil }
            func image(widgetID: String, ref: String) async throws -> Data? { nil }
        }
        let none = try await Bare().pinnedWidgets()
        #expect(none.isEmpty)
    }

    @Test func theChatFixtureWidgetExists() async throws {
        let widget = try await store.widget(id: "wdg_saturday_route")
        #expect(widget.title == "Saturday route")
    }

    @MainActor @Test func pinsAndFeedDrawOpenAndReplyOnly() {
        for surface in [WidgetSurface.overview, .feed] {
            let runtime = WidgetRuntime(widgetID: "w", backend: store, surface: surface, snapshot: nil)
            #expect(runtime.allows(.reply(text: "hi")))
            #expect(runtime.allows(.open(route: "/chat/x", artifactID: nil, fileID: nil, url: nil)))
            #expect(!runtime.allows(.tool(name: "t", args: [:])))
            #expect(!runtime.allows(.answer(inputRequestID: "i", values: ["a"])))
        }
        let chat = WidgetRuntime(widgetID: "w", backend: store, surface: .chat, snapshot: nil)
        #expect(chat.allows(.tool(name: "t", args: [:])))
    }
}
