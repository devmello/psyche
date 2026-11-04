import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

struct ChatMappingTests {
    private func map(_ blocks: [JSONValue], role: String = "agent") async -> [ChatItem] {
        let message = JSONValue.object(["id": "msg_1", "role": .string(role), "blocks": .array(blocks)])
        return await ChatMapping.items(from: message, lookupQuestion: { _ in nil })
    }

    @Test func aUiBlockBecomesAWidgetRow() async {
        let items = await map([.object(["type": "ui", "widgetId": "wdg_saturday_route"])])
        #expect(items == [.widget(id: "msg_1-0-ui", widgetID: "wdg_saturday_route")])
    }

    @Test func textAndWidgetKeepTheirOrderAndTheTextKeepsTheMessageId() async {
        let items = await map([
            .object(["type": "text", "md": "Here is the route."]),
            .object(["type": "ui", "widgetId": "wdg_1"]),
        ])
        #expect(items == [.assistant(id: "msg_1", text: "Here is the route.", streaming: false), .widget(id: "msg_1-1-ui", widgetID: "wdg_1")])
    }

    @Test func checklistRowsCarryTheirState() async {
        let items = await map([.object(["type": "checklist", "items": .array([
            .object(["text": "Book", "status": "completed"]), .object(["text": "Pack", "status": "in_progress"]),
            .object(["text": "Go", "status": "pending"]),
        ])])])
        guard case .progress(_, .checklist, _, let steps)? = items.first else { Issue.record("no progress row"); return }
        #expect(steps.map(\.state) == [.done, .running, .pending])
        #expect(steps.map(\.title) == ["Book", "Pack", "Go"])
    }

    @Test func blocksThatOnlyCarryAnIdAndUnknownTypesBecomeUnknown() async {
        let items = await map([
            .object(["type": "plan", "planId": "pln_1"]), .object(["type": "approval", "approvalId": "apr_1"]),
            .object(["type": "hologram", "x": .number(1)]),
        ])
        #expect(items == [
            .unknown(id: "msg_1-0-plan", type: "plan"), .unknown(id: "msg_1-1-approval", type: "approval"),
            .unknown(id: "msg_1-2-hologram", type: "hologram"),
        ])
    }

    @Test func otherSelfContainedBlocksMap() async {
        let items = await map([
            .object(["type": "app_link", "route": "/goals/g1"]),
            .object(["type": "file", "libraryItemId": "lib_1"]),
            .object(["type": "wrap_up", "recap": "Done.", "ask": "Ship it?"]),
            .object(["type": "taught", "statement": .null]),
            .object(["type": "related_threads", "items": .array([.object(["threadId": "thr_2", "title": "Rent", "snippet": "Landlord"])])]),
        ])
        #expect(items.count == 5)
        #expect(items[0] == .appLink(id: "msg_1-0-app_link", title: "Open in Psyche", detail: "/goals/g1", route: "/goals/g1"))
        #expect(items[2] == .note(id: "msg_1-2-wrap_up", kind: .wrapUp, title: "Done.", detail: "Ship it?"))
        #expect(items[4] == .relatedThreads(id: "msg_1-4-related_threads", threads: [RelatedThread(id: "thr_2", title: "Rent", status: "Landlord")]))
    }

    @Test func aSystemMessagesTextIsNotARow() async {
        #expect(await map([.object(["type": "text", "md": "internal"])], role: "system").isEmpty)
    }
}
