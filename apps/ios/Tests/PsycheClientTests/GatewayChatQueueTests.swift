import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import struct PsycheProtocol.WireReqFrame
import PsycheStore
import Testing

@testable import PsycheClient

/// The steer and follow-up calls against a fake Gateway: what the phone sends, and what it reads back.
struct GatewayChatQueueTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        let gateway = FakeGateway()
        configure(gateway)
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return (GatewayBackend(client: h.client), h)
    }

    static func queued(_ id: String, _ text: String, position: Int) -> JSONValue {
        .object([
            "messageId": .string(id), "threadId": "thr_1", "position": .number(Double(position)),
            "content": .string(text), "attachments": .array([]), "createdAt": "2030-01-01T09:12:00Z",
        ])
    }

    @Test func steerSendsTheTextWithAKeyAndReturnsNothingToQueue() async throws {
        let calls = OutboxTests.Sent()
        let (backend, _) = try await live { g in
            g.on("chat.steer") { req in
                let p = req.params
                calls.add("\(p?["threadId"]?.stringValue ?? "")|\(p?["content"]?.stringValue ?? "")|\(req.idempotencyKey == nil ? "nokey" : "key")")
                return .success(.object(["messageId": "m1"]))
            }
        }
        try await backend.steer(threadID: "thr_1", text: "Use the other file")
        #expect(calls.all == ["thr_1|Use the other file|key"])
    }

    @Test func aQueuedFollowUpComesBackWithTheGatewaysId() async throws {
        let calls = OutboxTests.Sent()
        let (backend, _) = try await live { g in
            g.on("chat.followUp") { req in
                calls.add("\(req.params?["content"]?.stringValue ?? "")|\(req.idempotencyKey == nil ? "nokey" : "key")")
                return .success(.object(["messageId": "m9"]))
            }
        }
        let item = try await backend.queueFollowUp(threadID: "thr_1", text: "Then send it to Dana")
        #expect(item == QueuedFollowUp(id: "m9", threadID: "thr_1", position: .max, text: "Then send it to Dana"))
        #expect(calls.all == ["Then send it to Dana|key"])
    }

    @Test func theQueueReadsInRunOrderAndSkipsAnItemWithoutText() async throws {
        let (backend, _) = try await live { g in
            g.on("chat.queue.list") { _ in .success(.object(["items": .array([
                Self.queued("m2", "second", position: 1),
                .object(["messageId": "m3", "threadId": "thr_1", "position": .number(2)]),
                Self.queued("m1", "first", position: 0),
            ])])) }
        }
        let items = try await backend.queuedFollowUps(threadID: "thr_1")
        #expect(items.map(\.id) == ["m2", "m1"])
        #expect(items.map(\.text) == ["second", "first"])
        #expect(items.map(\.position) == [1, 0])
    }

    @Test func removingReportsWhetherTheGatewayTookTheItemOut() async throws {
        let (backend, _) = try await live { g in
            g.on("chat.queue.remove") { req in
                .success(.object(["removed": .bool(req.params?["messageId"]?.stringValue == "m1")]))
            }
        }
        #expect(try await backend.removeQueuedFollowUp(threadID: "thr_1", id: "m1"))
        // Already started (or unknown): the Gateway says so, and the phone reads the queue again.
        #expect(try await backend.removeQueuedFollowUp(threadID: "thr_1", id: "m2") == false)
    }

    @Test func aRefusedSteerThrowsSoTheAlertCanShowIt() async throws {
        let (backend, _) = try await live { g in
            g.on("chat.steer") { _ in .failure(WireError(code: "conflict", message: "The reply already finished.")) }
        }
        do {
            try await backend.steer(threadID: "thr_1", text: "Too late")
            Issue.record("a refused steer must throw")
        } catch {
            #expect(!error.localizedDescription.isEmpty)
        }
    }
}
