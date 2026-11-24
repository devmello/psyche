import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// Fork, clear, compact, restore, archived chats and reply feedback over the Gateway's real method shapes.
struct ChatThreadMenuTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    @Test func forkSendsTheMessageAndReturnsTheNewChat() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.fork") { _ in
                .success(.object(["thread": .object(["id": "thr_fork", "kind": "side", "title": "Trip plans"])]))
            }
        }
        let forked = try await backend.forkThread(id: "thr_2", messageID: "msg_9", title: nil)
        #expect(forked.id == "thr_fork")
        let request = h.gateway.received.first { $0.method == "threads.fork" }
        #expect(request?.params?["threadId"]?.string == "thr_2")
        #expect(request?.params?["messageId"]?.string == "msg_9")
        #expect(request?.params?["title"] == nil)
    }

    @Test func forkSendsATitleWhenGiven() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.fork") { _ in .success(.object(["thread": .object(["id": "thr_fork", "kind": "side"])])) }
        }
        _ = try await backend.forkThread(id: "thr_2", messageID: "msg_9", title: "Second try")
        #expect(h.gateway.received.first { $0.method == "threads.fork" }?.params?["title"]?.string == "Second try")
    }

    @Test func clearSendsTheThreadId() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.clear") { _ in .success(.object(["ok": .bool(true)])) }
        }
        try await backend.clearThread(id: "thr_2")
        #expect(h.gateway.received.first { $0.method == "threads.clear" }?.params?["threadId"]?.string == "thr_2")
    }

    @Test func aRefusedClearThrowsSoTheThreadKeepsItsMessages() async throws {
        let (backend, _) = try await live { g in
            g.on("threads.clear") { _ in .failure(WireError(code: "conflict", message: "The chat is running.")) }
        }
        do {
            try await backend.clearThread(id: "thr_2")
            Issue.record("a refused clear should throw")
        } catch {
            // Thrown, not swallowed: the thread model shows the Gateway's words and leaves the transcript alone.
        }
    }

    @Test func compactReportsWhetherAnythingWasSummarised() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.compact") { req in
                req.params?["threadId"]?.string == "thr_empty"
                    ? .success(.object(["compaction": .null]))
                    : .success(.object(["compaction": .object([
                        "compactionId": "cmp_1", "messageId": "msg_5", "tokensBefore": .number(9000),
                        "tokensAfter": .number(1200), "replacedTurns": .number(12),
                    ])]))
            }
        }
        #expect(try await backend.compactThread(id: "thr_2") == true)
        #expect(try await backend.compactThread(id: "thr_empty") == false)
        #expect(h.gateway.received.first { $0.method == "threads.compact" }?.params?["threadId"]?.string == "thr_2")
    }

    @Test func restoreSendsTheThreadId() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.restore") { _ in .success(.object(["thread": .object(["id": "thr_2", "kind": "side"])])) }
        }
        try await backend.restoreThread(id: "thr_2")
        #expect(h.gateway.received.first { $0.method == "threads.restore" }?.params?["threadId"]?.string == "thr_2")
    }

    @Test func archivedChatsAreTheArchivedRowsOfAListThatIncludesThem() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.list") { _ in
                .success(.object(["threads": .array([
                    .object(["thread": .object(["id": "thr_live", "kind": "side", "title": "Live", "archivedAt": .null])]),
                    .object(["thread": .object([
                        "id": "thr_old", "kind": "side", "title": "Old", "archivedAt": "2026-11-20T10:00:00.000Z",
                    ])]),
                ])]))
            }
        }
        let archived = try await backend.archivedThreads()
        #expect(archived.map(\.id) == ["thr_old"])
        #expect(archived.first?.isArchived == true)
        #expect(h.gateway.received.first { $0.method == "threads.list" }?.params?["includeArchived"] == .bool(true))
    }

    @Test func thumbsSendTheTargetAndTheKind() async throws {
        let (backend, h) = try await live { g in
            g.on("feedback.give") { _ in .success(.object(["event": .object([:]), "lesson": .null, "approval": .null])) }
        }
        try await backend.giveFeedback(threadID: "thr_2", messageID: "msg_9", helpful: false)
        let request = h.gateway.received.first { $0.method == "feedback.give" }
        let target = request?.params?["target"]
        #expect(target?["type"]?.string == "message")
        #expect(target?["id"]?.string == "msg_9")
        #expect(target?["threadId"]?.string == "thr_2")
        #expect(request?.params?["kind"]?.string == "not_helpful")
        #expect(request?.params?["text"] == nil)
    }

    @Test func aHelpfulMarkSendsHelpful() async throws {
        let (backend, h) = try await live { g in
            g.on("feedback.give") { _ in .success(.object(["event": .object([:]), "lesson": .null, "approval": .null])) }
        }
        try await backend.giveFeedback(threadID: "thr_2", messageID: "msg_9", helpful: true)
        #expect(h.gateway.received.first { $0.method == "feedback.give" }?.params?["kind"]?.string == "helpful")
    }
}
