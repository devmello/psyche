import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// The params each request carried, so a test can check the cursor went out.
final class SeenParams: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [JSONValue?] = []

    func add(_ value: JSONValue?) { lock.withLock { values.append(value) } }
    func reset() { lock.withLock { values = [] } }
    var all: [JSONValue?] { lock.withLock { values } }
}

struct GatewayChatPagingTests {
    @Test func threadPagesSendTheCursorAndReturnTheNextOne() async throws {
        let seen = SeenParams()
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("threads.list") { req in
                seen.add(req.params)
                return .success(.object([
                    "threads": .array([GatewayBackendTests.thread("thr_a", title: "A")]),
                    "nextCursor": "cur2",
                ]))
            }
        }
        let first = try await backend.threadPage(cursor: nil)
        #expect(first.threads.map(\.id) == ["thr_a"])
        #expect(first.nextCursor == "cur2")
        let second = try await backend.threadPage(cursor: first.nextCursor)
        #expect(second.nextCursor == "cur2")
        #expect(seen.all[0]?["cursor"] == nil)
        #expect(seen.all[1]?["cursor"]?.string == "cur2")
        #expect(seen.all[1]?["limit"]?.int == 60)
    }

    @Test func aTranscriptPagesBackFromTheNewestMessage() async throws {
        let seen = SeenParams()
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("threads.get") { _ in .success(GatewayBackendTests.thread("thr_1", title: "Rent")) }
            g.on("chat.history") { req in
                seen.add(req.params)
                let older = req.params?["cursor"]?.string != nil
                let id = older ? "m0" : "m9"
                let text = older ? "Older" : "Newest"
                return .success(.object([
                    "messages": .array([.object([
                        "id": .string(id), "threadId": "thr_1", "role": "user",
                        "blocks": .array([.object(["type": "text", "md": .string(text)])]),
                    ])]),
                    "nextCursor": older ? .null : "c1",
                ]))
            }
        }
        let newest = try await backend.thread(id: "thr_1")
        #expect(newest.items == [.user(id: "m9", text: "Newest")])
        #expect(newest.olderCursor == "c1")

        let older = try await backend.olderItems(threadID: "thr_1", before: "c1")
        #expect(older.items == [.user(id: "m0", text: "Older")])
        #expect(older.nextCursor == nil)
        #expect(seen.all[1]?["cursor"]?.string == "c1")
    }
}
