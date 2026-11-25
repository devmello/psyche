import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheShared
import PsycheStore
import PsycheWire
import Testing

@testable import PsycheClient

/// What becomes of a message that waited in the outbox: the open thread hears about it, and a retryable error
/// is tried again while the phone is live.
struct OutboxOutcomeTests {
    typealias Harness = GatewayClientTests.Harness

    static func entry(_ id: String) -> OutboxEntry {
        OutboxEntry(id: id, kind: .chatSend, method: "chat.send", params: .object(["threadId": "t1", "content": .string(id)]))
    }

    /// Collects the `sendResult` events the client publishes.
    final class Results: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [ChatEvent] = []
        func add(_ event: ChatEvent) { lock.withLock { items.append(event) } }
        var all: [ChatEvent] { lock.withLock { items } }
    }

    static func collect(_ client: GatewayClient) -> (Results, Task<Void, Never>) {
        let results = Results()
        let stream = client.liveEvents()
        let task = Task {
            for await event in stream {
                if case .chat(let chat) = event, case .sendResult = chat { results.add(chat) }
            }
        }
        return (results, task)
    }

    @Test func aMessageTheGatewayRefusesAfterWaitingOfflineIsReportedAsFailed() async throws {
        let gateway = FakeGateway()
        gateway.on("chat.send") { _ in .failure(WireError(code: "forbidden", message: "This phone can't send.")) }
        let h = Harness(gateway: gateway)
        let (results, task) = Self.collect(h.client)
        defer { task.cancel() }
        try await GatewayClientTests.pairedThenOffline(h)
        #expect(await h.client.submit(Self.entry("m1")) == .queued)
        gateway.down = false
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        try await Task.sleep(for: .milliseconds(300))
        #expect(results.all == [.sendResult(threadID: "t1", messageID: "m1", failure: "This phone can't send.")])
        #expect(await h.outbox.isEmpty)
    }

    @Test func aRetryableErrorIsRetriedWithBackoffWhileLiveAndThenReported() async throws {
        let gateway = FakeGateway()
        let attempts = OutboxTests.Sent()
        gateway.on("chat.send") { req in
            attempts.add(req.idempotencyKey ?? "?")
            if attempts.all.count < 3 { return .failure(WireError(code: "unavailable", message: "Busy.", retryable: true)) }
            return .success(.object(["messageId": "m-m1", "queued": .bool(false)]))
        }
        let h = Harness(gateway: gateway)
        let (results, task) = Self.collect(h.client)
        defer { task.cancel() }
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        // Live, yet the Gateway is busy: the message stays queued, and nothing but the retry sends it again.
        #expect(await h.client.submit(Self.entry("m1")) == .queued)
        try await Task.sleep(for: .milliseconds(600))
        #expect(attempts.all.count == 3)
        #expect(await h.outbox.isEmpty)
        #expect(results.all == [.sendResult(threadID: "t1", messageID: "m1", failure: nil)])
    }
}
