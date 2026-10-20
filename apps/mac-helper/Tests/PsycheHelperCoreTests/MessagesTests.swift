import Foundation
@testable import PsycheHelperCore
import PsycheProtocol
import Testing

@Suite("messages: chat.db reads (J7)")
struct ChatDatabaseTests {
    /// Alice (iMessage 1:1), Bob (SMS 1:1) and a group chat.
    static func fixture(modern: Bool = true) -> (ChatDBFixture, alice: Int64, bob: Int64, group: Int64, aliceHandle: Int64) {
        let f = ChatDBFixture(modern: modern)
        let alice = f.handle("+15551110000")
        let bob = f.handle("+15552220000", service: "SMS")
        let carol = f.handle("Carol@Example.com")
        let aliceChat = f.chat("iMessage;-;+15551110000", identifier: "+15551110000", handles: [alice])
        let bobChat = f.chat("SMS;-;+15552220000", identifier: "+15552220000", service: "SMS", handles: [bob])
        let group = f.chat("iMessage;+;chat123", style: 43, identifier: "chat123", name: "Climbing", handles: [alice, carol])
        return (f, aliceChat, bobChat, group, alice)
    }

    @Test func readsRecentAndAfterCursorAscending() throws {
        let (f, aliceChat, bobChat, _, alice) = Self.fixture()
        let bobHandle: Int64 = 2
        f.message(chat: aliceChat, handle: alice, text: "one", date: 783_000_000)
        f.message(chat: aliceChat, text: "two", fromMe: true, date: 783_000_010)
        f.message(chat: bobChat, handle: bobHandle, text: "sms", service: "SMS", date: 783_000_020)
        f.message(chat: aliceChat, handle: alice, text: "three", date: 783_000_030)
        let db = try ChatDatabase(path: f.path)

        let recent = try db.read(chatId: nil, handle: "+15551110000", since: nil, limit: 2)
        #expect(recent.messages.map(\.text) == ["two", "three"])
        #expect(recent.hasMore)
        #expect(recent.cursor == 4)
        #expect(recent.messages[0].isFromMe && recent.messages[0].sender == nil)
        #expect(recent.messages[1].sender?.handle == "+15551110000")
        #expect(recent.messages[1].sentAt == "2025-10-24T12:00:30.000Z")

        let after = try db.read(chatId: nil, handle: nil, since: 1, limit: 10)
        #expect(after.messages.map(\.cursor) == [2, 3, 4])
        #expect(after.messages[1].service == .sms)
        #expect(after.messages[1].sender?.service == .sms)
        #expect(!after.hasMore)
        let none = try db.read(chatId: nil, handle: nil, since: 4, limit: 10)
        #expect(none.messages.isEmpty && none.cursor == 4)
        #expect(try db.lastCursor() == 4)
    }

    @Test func listsChatsNewestFirstWithParticipants() throws {
        let (f, aliceChat, bobChat, group, alice) = Self.fixture()
        f.message(chat: bobChat, handle: 2, text: "a", service: "SMS")
        f.message(chat: group, handle: alice, text: "b")
        f.message(chat: aliceChat, handle: alice, text: "c")
        let db = try ChatDatabase(path: f.path)
        let chats = try db.chats(limit: 10, query: nil)
        #expect(chats.map(\.chatID) == ["iMessage;-;+15551110000", "iMessage;+;chat123", "SMS;-;+15552220000"])
        let g = chats[1]
        #expect(g.isGroup && g.displayName == "Climbing")
        #expect(g.participants.map(\.handle) == ["+15551110000", "carol@example.com"])
        #expect(chats[2].service == .sms)
        #expect(try db.chats(limit: 10, query: "CAROL").map(\.chatID) == ["iMessage;+;chat123"])
    }

    @Test func decodesAttributedBodyTapbacksRepliesAndAttachments() throws {
        let (f, aliceChat, _, _, alice) = Self.fixture()
        let body = NSArchiver.archivedData(withRootObject: NSAttributedString(string: "from typedstream 🙂"))
        let first = f.message(chat: aliceChat, handle: alice, text: nil, body: body)
        let target = f.guid(of: first)
        f.message(chat: aliceChat, handle: alice, text: "Liked “from typedstream”", reactionType: 2001, reactionTarget: "p:0/\(target)")
        f.message(chat: aliceChat, handle: alice, text: "Removed a like", reactionType: 3001, reactionTarget: "bp:\(target)")
        f.message(chat: aliceChat, handle: alice, text: "reply", replyTo: target, edited: 783_000_100_000_000_000)
        let voice = f.message(chat: aliceChat, handle: alice, text: "\u{FFFC}", audio: true)
        f.attach(voice, name: "Audio Message.caf", uti: "com.apple.coreaudio-format", mime: "audio/x-caf", bytes: 12_345)
        let photo = f.message(chat: aliceChat, handle: alice, text: "\u{FFFC}look")
        f.attach(photo, name: "IMG_1.HEIC", uti: "public.heic", mime: "image/heic", bytes: 99)

        let m = try ChatDatabase(path: f.path).read(chatId: "iMessage;-;+15551110000", handle: nil, since: 0, limit: 50).messages
        #expect(m[0].text == "from typedstream 🙂")
        #expect(m[1].reaction?.kind == .like && m[1].reaction?.removed == false && m[1].reaction?.targetGUID == target)
        #expect(m[2].reaction?.removed == true && m[2].reaction?.targetGUID == target)
        #expect(m[3].replyToGUID == target && m[3].editedAt != nil)
        #expect(m[4].text == nil)
        #expect(m[4].attachments.count == 1 && m[4].attachments[0].isVoiceNote && m[4].attachments[0].totalBytes == 12_345)
        #expect(m[4].attachments[0].filename == "Audio Message.caf")
        #expect(m[5].text == "look" && m[5].attachments[0].mimeType == "image/heic" && !m[5].attachments[0].isVoiceNote)
        // Metadata only: no filesystem path is ever returned.
        let encoded = String(data: try JSONEncoder().encode(m), encoding: .utf8) ?? ""
        #expect(!encoded.contains("Library/Messages/Attachments"))
    }

    @Test func readsAnOlderSchemaWithoutOptionalColumns() throws {
        let (f, aliceChat, _, _, alice) = Self.fixture(modern: false)
        f.message(chat: aliceChat, handle: alice, text: "old")
        let m = try ChatDatabase(path: f.path).read(chatId: nil, handle: nil, since: nil, limit: 5).messages
        #expect(m.map(\.text) == ["old"])
        #expect(m[0].replyToGUID == nil && m[0].editedAt == nil)
    }

    @Test func macOS26AnyChatGuidsTakeTheServiceFromTheMessage() throws {
        let f = ChatDBFixture()
        let h = f.handle("+15553330000")
        let chat = f.chat("any;-;+15553330000", identifier: "+15553330000", service: "any", handles: [h])
        f.message(chat: chat, handle: h, text: "hi", service: "iMessage")
        let db = try ChatDatabase(path: f.path)
        #expect(try db.read(chatId: nil, handle: "+15553330000", since: nil, limit: 1).messages[0].service == .imessage)
        #expect(try db.chats(limit: 5, query: nil)[0].service == .unknown)
    }

    @Test func missingDatabaseOrNoAccessIsAClearError() {
        // A directory we can list but without chat.db.
        let dir = NSTemporaryDirectory() + "psyche-empty-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        #expect(throws: CapabilityError.self) { try ChatDatabase(path: dir + "/chat.db") }
        do { _ = try ChatDatabase(path: dir + "/chat.db") } catch let e as CapabilityError { #expect(e.reason == "database_missing") } catch {}
        // A parent directory we cannot list stands in for ~/Library/Messages without Full Disk Access.
        do { _ = try ChatDatabase(path: "/nonexistent-\(UUID().uuidString)/chat.db") } catch let e as CapabilityError {
            #expect(e.reason == "full_disk_access_missing")
            #expect(e.message.contains("Full Disk Access"))
        } catch {}
        // An unreadable file (what TCC does to chat.db without the grant).
        let f = ChatDBFixture()
        chmod(f.path, 0)
        defer { chmod(f.path, 0o644) }
        do { _ = try ChatDatabase(path: f.path) } catch let e as CapabilityError { #expect(e.reason == "full_disk_access_missing") } catch {}
    }

    @Test func neverWritesTheDatabase() throws {
        let (f, aliceChat, _, _, alice) = Self.fixture()
        f.message(chat: aliceChat, handle: alice, text: "x")
        let db = try ChatDatabase(path: f.path)
        #expect(throws: (any Error).self) { try db.db.query("DELETE FROM message") }
        #expect(try db.lastCursor() == 1)
    }
}

@Suite("messages: typedstream, send script, watcher (J7)")
struct MessagesCoreTests {
    @Test func typedStreamLengths() {
        for s in ["", "a", String(repeating: "x", count: 127), String(repeating: "é", count: 200), String(repeating: "y", count: 70_000)] {
            let d = NSArchiver.archivedData(withRootObject: NSAttributedString(string: s))
            #expect(TypedStream.text(from: d) == s)
        }
        #expect(TypedStream.text(from: Data("garbage NSString".utf8)) == nil)
        #expect(TypedStream.text(from: Data()) == nil)
    }

    @Test func sendValidation() throws {
        func v(_ to: String?, _ chat: String?, _ text: String = "hi", _ service: String? = nil) throws -> MessagesCore.Recipient {
            try MessagesCore.validate(MessagesCore.SendParams(to: to, chatId: chat, text: text, service: service)).0
        }
        #expect(try v("+15551110000", nil) == .handle("+15551110000", service: .imessage))
        #expect(try v("Me@Example.COM", nil, "x", "sms") == .handle("me@example.com", service: .sms))
        #expect(try v(nil, "iMessage;+;chat123") == .chat("iMessage;+;chat123"))
        for bad: (String?, String?, String, String?) in [
            (nil, nil, "hi", nil), ("+1555", "iMessage;-;+1555", "hi", nil), ("\" & do shell script \"x", nil, "hi", nil),
            (nil, "iMessage;+;x\" & quit", "hi", nil), ("+15551110000", nil, "", nil), ("+15551110000", nil, "hi", "whatsapp"),
        ] {
            #expect(throws: CapabilityError.self) { try v(bad.0, bad.1, bad.2, bad.3) }
        }
    }

    @Test func sendScriptsEscapeTextAndHandleChatGuids() {
        let text = "say \"hi\" \\ then\nend tell\ndo shell script \"rm\""
        let s = MessagesCore.sendScripts(.handle("+15551110000", service: .imessage), text: text)
        #expect(s.count == 1)
        #expect(s[0].contains(#"send "say \"hi\" \\ then"#))
        #expect(s[0].contains("service type is iMessage") && s[0].contains(#"participant "+15551110000""#))
        // The text never terminates the literal: every quote inside it is escaped.
        let body = s[0].components(separatedBy: "send ")[1].components(separatedBy: " to participant")[0]
        #expect(body.hasPrefix("\"") && body.hasSuffix("\""))
        #expect(!body.dropFirst().dropLast().replacingOccurrences(of: "\\\\", with: "").replacingOccurrences(of: "\\\"", with: "").contains("\""))

        let oneToOne = MessagesCore.sendScripts(.chat("any;-;+15551110000"), text: "x")
        #expect(oneToOne.count == 1 && oneToOne[0].contains(#"participant "+15551110000""#))
        let sms = MessagesCore.sendScripts(.chat("SMS;-;+15552220000"), text: "x")
        #expect(sms[0].contains("service type is SMS"))
        let group = MessagesCore.sendScripts(.chat("iMessage;+;chat123"), text: "x")
        #expect(group.map { $0.contains("chat id \"iMessage;+;chat123\"") } == [true, false])
        #expect(group[1].contains("chat id \"any;+;chat123\""))
    }

    actor Events {
        var items: [JSONValue] = []
        func add(_ v: JSONValue) { items.append(v) }
    }

    @Test func watcherStreamsNewRowsAfterTheCursorAndStopsOnCancel() async throws {
        let (f, aliceChat, _, _, alice) = ChatDatabaseTests.fixture()
        f.message(chat: aliceChat, handle: alice, text: "old")
        let db = try ChatDatabase(path: f.path)
        let events = Events()
        let ticks = Counter()
        let watcher = MessagesCore.Watcher(
            read: { try db.read(chatId: nil, handle: nil, since: $0, limit: 2) },
            start: { try db.lastCursor() },
            sleep: { _ in
                let n = await ticks.next()
                if n == 1 {
                    f.message(chat: aliceChat, handle: alice, text: "new1")
                    f.message(chat: aliceChat, text: "mine", fromMe: true)
                    f.message(chat: aliceChat, handle: alice, text: "new2")
                }
                if n >= 3 { throw CancellationError() }
            }
        )
        await #expect(throws: CancellationError.self) {
            try await watcher.run(since: nil, intervalMs: 500, includeFromMe: false) { await events.add($0) }
        }
        let decoded = try await events.items.map { try $0.decode(as: MessagesWatchEvent.self) }
        let texts = decoded.flatMap { $0.messages ?? [] }.map(\.text)
        #expect(texts == ["new1", "new2"]) // "old" is not replayed; the owner's own row is filtered
        #expect(decoded.last?.cursor == 4)
    }

    @Test func watcherReportsMissingFullDiskAccessOnceAndEnds() async throws {
        let events = Events()
        let watcher = MessagesCore.Watcher(
            read: { _ in throw ChatDatabase.fullDiskAccessMissing },
            start: { 0 },
            sleep: { _ in }
        )
        await #expect(throws: CapabilityError.self) {
            try await watcher.run(since: 3, intervalMs: 500, includeFromMe: true) { await events.add($0) }
        }
        let decoded = try await events.items.map { try $0.decode(as: MessagesWatchEvent.self) }
        #expect(decoded.count == 1)
        #expect(decoded[0].type == .messagesWatchError && decoded[0].reason == "full_disk_access_missing" && decoded[0].retryable == false)
    }

    @Test func watcherBacksOffOnABusyDatabase() async throws {
        let events = Events()
        let delays = Recorder()
        let calls = Counter()
        let watcher = MessagesCore.Watcher(
            read: { _ in throw CapabilityError(.unavailable, reason: "database_locked", "busy", retryable: true) },
            start: { 0 },
            sleep: { d in
                await delays.add(d)
                if await calls.next() >= 3 { throw CancellationError() }
            }
        )
        await #expect(throws: CancellationError.self) {
            try await watcher.run(since: 0, intervalMs: 1000, includeFromMe: false) { await events.add($0) }
        }
        #expect(await events.items.count == 1)
        #expect(await delays.items == [.seconds(2), .seconds(4), .seconds(8)])
    }

    actor Counter {
        var n = 0
        func next() -> Int { n += 1; return n }
    }

    actor Recorder {
        var items: [Duration] = []
        func add(_ d: Duration) { items.append(d) }
    }
}
