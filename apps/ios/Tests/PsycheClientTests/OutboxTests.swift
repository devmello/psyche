import Foundation
import enum PsycheProtocol.JSONValue
import Testing

@testable import PsycheClient

struct OutboxTests {
    static func entry(_ id: String) -> OutboxEntry {
        OutboxEntry(id: id, kind: .chatSend, method: "chat.send", params: .object(["content": .string(id)]))
    }

    final class Sent: @unchecked Sendable {
        private let lock = NSLock()
        private var ids: [String] = []
        var all: [String] { lock.withLock { ids } }
        func add(_ id: String) { lock.withLock { ids.append(id) } }
    }

    @Test func flushesInOrderAndEmptiesTheQueue() async {
        let outbox = Outbox(directory: nil)
        for id in ["a", "b", "c"] { await outbox.enqueue(Self.entry(id)) }
        let sent = Sent()
        let outcomes = await outbox.flush { e in sent.add(e.id); return .object(["ok": .bool(true)]) }
        #expect(sent.all == ["a", "b", "c"])
        #expect(outcomes.count == 3)
        #expect(await outbox.isEmpty)
    }

    @Test func stopsAtTheFirstUnreachableEntryAndKeepsOrder() async {
        let outbox = Outbox(directory: nil)
        for id in ["a", "b", "c"] { await outbox.enqueue(Self.entry(id)) }
        let sent = Sent()
        _ = await outbox.flush { e in
            if e.id == "b" { throw Outbox.OutboxSendError.retryLater }
            sent.add(e.id)
            return .null
        }
        #expect(sent.all == ["a"])  // c must not overtake b
        #expect(await outbox.pending.map(\.id) == ["b", "c"])
        _ = await outbox.flush { e in sent.add(e.id); return .null }
        #expect(sent.all == ["a", "b", "c"])
    }

    @Test func aWipeDuringASendNeitherCrashesNorDropsAnEntryQueuedAfterIt() async {
        let outbox = Outbox(directory: nil)
        await outbox.enqueue(Self.entry("a"))
        let sent = Sent()
        let outcomes = await outbox.flush { e in
            sent.add(e.id)
            if e.id == "a" {  // revoked while this one is in flight, then the phone is paired again
                await outbox.wipe()
                await outbox.enqueue(Self.entry("z"))
            }
            return .null
        }
        #expect(sent.all == ["a", "z"])  // z was sent, not removed unsent in a's place
        #expect(Set(outcomes.keys) == ["a", "z"])
        #expect(await outbox.isEmpty)
    }

    @Test func aFlushThatFindsAnotherRunningWaitsAndItsEntryOutcomeIsStillReported() async {
        let outbox = Outbox(directory: nil)
        await outbox.enqueue(Self.entry("a"))
        let gate = AsyncStream<Void>.makeStream()
        let first = Task {
            await outbox.flush { e in
                if e.id == "a" { for await _ in gate.stream { break } }  // a is in flight until released
                return .object(["id": .string(e.id)])
            }
        }
        try? await Task.sleep(for: .milliseconds(50))
        await outbox.enqueue(Self.entry("b"))
        let second = Task { await outbox.flush { e in .object(["id": .string(e.id)]) } }
        try? await Task.sleep(for: .milliseconds(50))
        gate.continuation.yield()
        _ = await first.value
        _ = await second.value
        // b went out in the first flush's loop; the caller who queued it still learns how it went.
        #expect(await outbox.takeOutcome(for: "b") == .delivered(.object(["id": "b"])))
        #expect(await outbox.takeOutcome(for: "b") == nil)
        #expect(await outbox.isEmpty)
    }

    @Test func aDuplicateIdIsQueuedOnce() async {
        let outbox = Outbox(directory: nil)
        await outbox.enqueue(Self.entry("a"))
        await outbox.enqueue(Self.entry("a"))
        #expect(await outbox.pending.count == 1)
    }

    @Test func aLostAcknowledgementResendsWithTheSameIdempotencyKey() async {
        // The send reaches the Gateway but the ack is lost: the entry stays queued and goes again
        // with the same id, which the Gateway answers with the original result.
        let outbox = Outbox(directory: nil)
        await outbox.enqueue(Self.entry("m1"))
        let seen = Sent()
        _ = await outbox.flush { e in seen.add(e.id); throw Outbox.OutboxSendError.retryLater }
        _ = await outbox.flush { e in seen.add(e.id); return .null }
        #expect(seen.all == ["m1", "m1"])
        #expect(await outbox.isEmpty)
    }

    @Test func aRefusedEntryIsDroppedAndTheRestStillGo() async {
        let outbox = Outbox(directory: nil)
        for id in ["a", "bad", "c"] { await outbox.enqueue(Self.entry(id)) }
        let sent = Sent()
        let outcomes = await outbox.flush { e in
            if e.id == "bad" { throw Outbox.OutboxSendError.rejected("forbidden") }
            sent.add(e.id)
            return .null
        }
        #expect(sent.all == ["a", "c"])
        #expect(outcomes["bad"] == .rejected("forbidden"))
        #expect(await outbox.isEmpty)
    }

    @Test func survivesARelaunch() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let first = Outbox(directory: dir)
        await first.enqueue(Self.entry("a"))
        await first.enqueue(Self.entry("b"))
        let second = Outbox(directory: dir)
        #expect(await second.pending.map(\.id) == ["a", "b"])
        await second.wipe()
        #expect(await Outbox(directory: dir).isEmpty)
    }

    @Test func onlyOneFlushRunsAtATime() async {
        let outbox = Outbox(directory: nil)
        await outbox.enqueue(Self.entry("a"))
        let sent = Sent()
        async let one = outbox.flush { e in
            try await Task.sleep(for: .milliseconds(80))
            sent.add(e.id)
            return .null
        }
        try? await Task.sleep(for: .milliseconds(20))
        let two = await outbox.flush { e in sent.add("dup-" + e.id); return .null }
        _ = await one
        #expect(two.isEmpty)
        #expect(sent.all == ["a"])
    }
}
