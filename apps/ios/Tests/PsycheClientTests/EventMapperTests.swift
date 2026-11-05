import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireEventFrame
import PsycheStore
import Testing

@testable import PsycheClient

struct EventMapperTests {
    func frame(_ event: String, _ payload: JSONValue, seq: Int = 1, sv: Int = 1) -> WireEventFrame {
        WireEventFrame(event: event, payload: payload, seq: seq, stateVersion: sv)
    }
    func mapper() -> EventMapper { EventMapper(lookupQuestion: { _ in ("Which one?", [ChatOption(id: "A", title: "A", detail: "")]) }) }

    @Test func widgetAndLibraryEventsMapToTheirTopics() async {
        var m = mapper()
        let patched = await m.map(frame("widget.updated", .object(["widgetId": "w1", "threadId": "t1", "rev": .number(2), "ops": .array([])])), ownDeviceID: "d").events
        #expect(patched == [.changed(.widgets), .changed(.home)])
        let task = await m.map(frame("task.updated", .object([:])), ownDeviceID: "d").events
        #expect(task.contains(.changed(.widgets)) && task.contains(.changed(.activity)) && task.contains(.changed(.home)))
        #expect(await m.map(frame("automation.updated", .object([:])), ownDeviceID: "d").events == [.changed(.widgets)])
        for event in ["library.item.changed", "artifact.updated"] {
            #expect(await m.map(frame(event, .object(["itemId": "lib_1", "change": "deleted"])), ownDeviceID: "d").events == [.changed(.library)])
        }
    }

    @Test func firstDeltaCreatesTheStreamingRowThenAppends() async {
        var m = mapper()
        let p: JSONValue = .object(["threadId": "t1", "messageId": "m1", "delta": "Hel"])
        let first = await m.map(frame("chat.delta", p), ownDeviceID: "d").events
        #expect(first == [.chat(.item(threadID: "t1", item: .assistant(id: "m1", text: "Hel", streaming: true)))])
        let next = await m.map(frame("chat.delta", .object(["threadId": "t1", "messageId": "m1", "delta": "lo"])), ownDeviceID: "d").events
        #expect(next == [.chat(.delta(threadID: "t1", itemID: "m1", text: "lo"))])
    }

    @Test func aCommittedMessageReplacesTheStreamingRowAndFinishesIt() async {
        var m = mapper()
        _ = await m.map(frame("chat.delta", .object(["threadId": "t1", "messageId": "m1", "delta": "Hi"])), ownDeviceID: "d")
        let message: JSONValue = .object(["message": .object([
            "id": "m1", "threadId": "t1", "role": "agent",
            "blocks": .array([.object(["type": "text", "md": "Hi there"])]),
        ])])
        let events = await m.map(frame("chat.message", message), ownDeviceID: "d").events
        #expect(events.contains(.chat(.item(threadID: "t1", item: .assistant(id: "m1", text: "Hi there", streaming: false)))))
        #expect(events.contains(.chat(.done(threadID: "t1", itemID: "m1"))))
        #expect(events.contains(.changed(.threads)))
    }

    @Test func userMessagesAndToolCallsMapToRows() async {
        var m = mapper()
        let message: JSONValue = .object(["message": .object([
            "id": "m2", "threadId": "t1", "role": "user", "blocks": .array([.object(["type": "text", "md": "Pay the bill"])]),
        ])])
        let user = await m.map(frame("chat.message", message), ownDeviceID: "d").events
        #expect(user.first == .chat(.item(threadID: "t1", item: .user(id: "m2", text: "Pay the bill"))))
        let block: JSONValue = .object(["threadId": "t1", "messageId": "m3", "block": .object([
            "type": "tool_call", "toolCallId": "tc1", "tool": "web_search", "status": "done", "level1": "Searched the web",
        ])])
        let tool = await m.map(frame("chat.block", block), ownDeviceID: "d").events
        #expect(tool == [.chat(.item(threadID: "t1", item: .toolCall(id: "tc1", symbol: "magnifyingglass", summary: "Searched the web")))])
    }

    @Test func aQuestionBlockLoadsItsOptions() async {
        var m = mapper()
        let block: JSONValue = .object(["threadId": "t1", "messageId": "m3", "block": .object(["type": "question", "inputRequestId": "q1"])])
        let events = await m.map(frame("chat.block", block), ownDeviceID: "d").events
        #expect(events.contains(.chat(.item(threadID: "t1", item: .question(id: "q1", title: "Which one?", options: [ChatOption(id: "A", title: "A", detail: "")])))))
        #expect(events.contains(.changed(.home)))
    }

    @Test func approvalsNotificationsAndTasksAreRefetchHints() async {
        var m = mapper()
        func topics(_ name: String) async -> [LiveEvent] { await m.map(frame(name, .object([:])), ownDeviceID: "d").events }
        let approvalCreated = await topics("approval.created")
        let approvalUpdated = await topics("approval.updated")
        let notification = await topics("notification.created")
        let task = await topics("task.updated")
        let thread = await topics("thread.updated")
        let memory = await topics("memory.entity.updated")
        let unknown = await topics("something.new.in.v9")
        #expect(approvalCreated.contains(.changed(.home)))
        #expect(approvalUpdated.contains(.changed(.activity)))
        #expect(notification == [.changed(.home)])
        #expect(task.contains(.changed(.activity)))
        #expect(thread == [.changed(.threads)])
        #expect(memory == [.changed(.memory)])
        #expect(unknown.isEmpty)
    }

    @Test func revokingThisDeviceIsReportedOthersAreNot() async {
        var m = mapper()
        let mine: JSONValue = .object(["device": .object(["id": "dev_me", "revokedAt": "2030-01-01T00:00:00Z"])])
        let other: JSONValue = .object(["device": .object(["id": "dev_other", "revokedAt": "2030-01-01T00:00:00Z"])])
        let stillPaired: JSONValue = .object(["device": .object(["id": "dev_me"])])
        let a = await m.map(frame("device.updated", mine), ownDeviceID: "dev_me").effect
        let b = await m.map(frame("device.updated", other), ownDeviceID: "dev_me").effect
        let c = await m.map(frame("device.updated", stillPaired), ownDeviceID: "dev_me").effect
        #expect(a == .thisDeviceRevoked)
        #expect(b == .none)
        #expect(c == .none)
    }
}

struct ResyncTests {
    @Test func theFirstConnectNeverResyncs() {
        var r = Resync(lastStateVersion: nil)
        let first = r.connected(stateVersion: 7)
        #expect(!first)
    }

    @Test func aMovedStateVersionResyncsOnReconnect() {
        var r = Resync(lastStateVersion: 7)
        let same = r.connected(stateVersion: 7)
        let moved = r.connected(stateVersion: 9)
        let settled = r.connected(stateVersion: 9)
        #expect(!same)
        #expect(moved)
        #expect(!settled)
    }

    @Test func aSkippedSeqResyncs() {
        var r = Resync(lastStateVersion: 1)
        _ = r.connected(stateVersion: 1)
        let one = r.observed(seq: 1, stateVersion: 2)
        let two = r.observed(seq: 2, stateVersion: 3)
        let gap = r.observed(seq: 5, stateVersion: 6)
        #expect(!one && !two)
        #expect(gap)
        #expect(r.lastStateVersion == 6)
    }
}
