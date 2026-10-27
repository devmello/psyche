import Foundation
@testable import PsycheHelperCore
import PsycheProtocol
import Testing

@Suite("messages.graph_*: metadata-only chat.db reads (#763)")
struct GraphMessagesTests {
    static let secret = "PRIVATE-BODY-7f3a"

    struct World {
        let f: ChatDBFixture
        let db: ChatDatabase
        let dm: Int64
        let group: Int64
        let alice: Int64
    }

    /// Alice 1:1 (messages 1-3: inbound, outbound, reaction), a named group with Alice and Carol
    /// (message 4 inbound from Carol, 5 outbound), and an empty chat.
    static func world(modern: Bool = true) throws -> World {
        let f = ChatDBFixture(modern: modern)
        let alice = f.handle("+15551110000")
        let carol = f.handle("Carol@Example.com")
        let dm = f.chat("iMessage;-;+15551110000", identifier: "+15551110000", name: "Alice Secret Name", handles: [alice])
        let group = f.chat("iMessage;+;chat123", style: 43, identifier: "chat123", name: "Climbing Crew", handles: [alice, carol])
        f.chat("iMessage;-;+15553330000", identifier: "+15553330000", handles: [])
        f.message(chat: dm, handle: alice, text: "\(secret) in", date: 783_000_000)
        f.message(chat: dm, text: "\(secret) out", fromMe: true, date: 783_000_010)
        f.message(chat: dm, handle: alice, text: "Liked \(secret)", date: 783_000_020, reactionType: 2001, reactionTarget: "p:0/x")
        f.message(chat: group, handle: carol, text: "\(secret) group", date: 783_000_030)
        f.message(chat: group, text: "\(secret) group out", fromMe: true, date: 783_000_040)
        return World(f: f, db: try ChatDatabase(path: f.path), dm: dm, group: group, alice: alice)
    }

    static func json(_ value: some Encodable) throws -> String {
        String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    }

    @Test func chatsListHandlesAndGroupFlagWithoutNames() throws {
        let w = try Self.world()
        let result = try w.db.graphChats(limit: 200)
        #expect(result.chats.map(\.chatId) == ["iMessage;+;chat123", "iMessage;-;+15551110000", "iMessage;-;+15553330000"])
        #expect(result.chats[0].handles == ["+15551110000", "carol@example.com"])
        #expect(result.chats[0].isGroup)
        #expect(result.chats[1].handles == ["+15551110000"] && !result.chats[1].isGroup)
        #expect(result.chats[2].handles.isEmpty)
        #expect(try w.db.graphChats(limit: 1).chats.count == 1)

        let wire = try Self.json(result)
        #expect(!wire.contains("Alice Secret Name") && !wire.contains("Climbing Crew"))
        #expect(!wire.contains("displayName") && !wire.contains("service") && !wire.contains(Self.secret))
        let value = try JSONValue(encoding: result)
        guard case .object(let keys)? = value["chats"].flatMap({ if case .array(let a) = $0 { return a.first } else { return nil } }) else {
            Issue.record("expected a chat object")
            return
        }
        #expect(Set(keys.keys) == ["chatId", "handles", "isGroup"])
    }

    @Test func readDefaultsToMetadataOnly() throws {
        let w = try Self.world()
        let page = try w.db.graphRead(since: nil, limit: 200, includeText: false)
        #expect(page.messages.count == 4) // the reaction row is excluded
        #expect(page.cursor == 5 && !page.hasMore)
        let m = page.messages
        #expect(m.map(\.direction) == [.in, .out, .in, .out])
        #expect(m.map(\.chatId) == ["iMessage;-;+15551110000", "iMessage;-;+15551110000", "iMessage;+;chat123", "iMessage;+;chat123"])
        #expect(m[0].handle == "+15551110000" && m[1].handle == nil)
        #expect(m[2].handle == "carol@example.com" && m[3].handle == nil)
        #expect(m[0].sentAt == "2025-10-24T12:00:00.000Z" && m[1].sentAt == "2025-10-24T12:00:10.000Z")
        #expect(m.allSatisfy { $0.text == nil })

        let wire = try Self.json(page)
        #expect(!wire.contains(Self.secret) && !wire.contains("\"text\""))
        let value = try JSONValue(encoding: page)
        #expect(value["cursor"] == .number(5) && value["hasMore"] == .bool(false))
        guard case .array(let messages)? = value["messages"], case .object(let outbound) = messages[1], case .object(let inbound) = messages[0] else {
            Issue.record("expected message objects")
            return
        }
        #expect(Set(outbound.keys) == ["chatId", "sentAt", "direction"] && outbound["direction"] == .string("out"))
        #expect(Set(inbound.keys) == ["chatId", "handle", "sentAt", "direction"] && inbound["direction"] == .string("in"))
    }

    @Test func emptyDatabaseHasANullCursor() throws {
        let f = ChatDBFixture()
        f.chat("iMessage;-;+15551110000", identifier: "+15551110000", handles: [])
        let page = try ChatDatabase(path: f.path).graphRead(since: nil, limit: 10, includeText: false)
        #expect(page.messages.isEmpty && page.cursor == nil && !page.hasMore)
        #expect(try JSONValue(encoding: page)["cursor"] == .null)
    }

    @Test func includeTextReturnsTheBody() throws {
        let w = try Self.world()
        let page = try w.db.graphRead(since: nil, limit: 200, includeText: true)
        #expect(page.messages.map(\.text) == ["\(Self.secret) in", "\(Self.secret) out", "\(Self.secret) group", "\(Self.secret) group out"])
        #expect(try Self.json(page).contains("\"text\""))
    }

    @Test func attributedBodyIsOnlyDecodedWhenTextIsRequested() throws {
        let f = ChatDBFixture()
        let alice = f.handle("+15551110000")
        let dm = f.chat("iMessage;-;+15551110000", identifier: "+15551110000", handles: [alice])
        let body = NSArchiver.archivedData(withRootObject: NSAttributedString(string: Self.secret))
        f.message(chat: dm, handle: alice, text: nil, body: body)
        let db = try ChatDatabase(path: f.path)

        let plain = try db.graphRead(since: nil, limit: 10, includeText: false)
        #expect(plain.messages.count == 1 && plain.messages[0].text == nil)
        #expect(!(try Self.json(plain)).contains(Self.secret))
        #expect(try db.graphRead(since: nil, limit: 10, includeText: true).messages.first?.text == Self.secret)
    }

    @Test func sinceCursorPagesAscendingAndSetsHasMore() throws {
        let w = try Self.world()
        let first = try w.db.graphRead(since: 0, limit: 2, includeText: false)
        #expect(first.messages.map(\.direction) == [.in, .out])
        #expect(first.cursor == 2 && first.hasMore) // row 3 is a reaction, but row 4 is still pending

        let second = try w.db.graphRead(since: first.cursor, limit: 2, includeText: false)
        #expect(second.messages.count == 2 && second.cursor == 5 && !second.hasMore)

        let exact = try w.db.graphRead(since: 0, limit: 4, includeText: false)
        #expect(exact.messages.count == 4 && exact.cursor == 5 && !exact.hasMore)

        let none = try w.db.graphRead(since: 5, limit: 10, includeText: false)
        #expect(none.messages.isEmpty && none.cursor == 5 && !none.hasMore)
    }

    @Test func newestWindowWithoutCursorIsAscendingAndNeverHasMore() throws {
        let w = try Self.world()
        let page = try w.db.graphRead(since: nil, limit: 2, includeText: false)
        #expect(page.messages.map(\.chatId) == ["iMessage;+;chat123", "iMessage;+;chat123"])
        #expect(page.messages.map(\.direction) == [.in, .out])
        #expect(page.cursor == 5 && !page.hasMore)
    }

    @Test func unlinkedRowsAreSkippedAndOldSchemasStillRead() throws {
        let w = try Self.world(modern: false)
        let orphan = w.f.insert("""
            INSERT INTO message (guid, text, handle_id, service, date, is_from_me) VALUES ('orphan', 'orphan-body', 1, 'iMessage', 783000050000000000, 0)
            """, [])
        let page = try w.db.graphRead(since: nil, limit: 200, includeText: false)
        #expect(page.messages.count == 4 && page.cursor != Int(orphan))
    }
}
