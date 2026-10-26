import Foundation
import PsycheHelperCore
import SQLite3
import Testing

/// A fixture `Envelope Index` with the tables and columns `mail.search` reads. No real Mail.
final class MailIndexFixture: @unchecked Sendable {
    let dir: String
    var path: String { dir + "/Envelope Index" }
    private var db: OpaquePointer?

    init(deleted: Bool = true, globalData: Bool = true, schemaOK: Bool = true) {
        dir = NSTemporaryDirectory() + "psyche-mailindex-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        sqlite3_open(path, &db)
        exec("""
            CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL);
            CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, comment TEXT);
            CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT);
            \(globalData ? "CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id_header TEXT);" : "")
            CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, \(schemaOK ? "subject" : "subj") INTEGER, sender INTEGER,
                                   date_received INTEGER, mailbox INTEGER, read INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0
                                   \(deleted ? ", deleted INTEGER DEFAULT 0" : "")\(globalData ? ", global_message_id INTEGER" : ""));
            """)
    }

    // The folder stays in the temp directory: a test may drop the fixture while its reader is open.
    deinit { sqlite3_close(db) }

    func exec(_ sql: String) {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK { fatalError("fixture SQL failed: \(err.map { String(cString: $0) } ?? "?")\n\(sql)") }
    }

    func rowid(_ sql: String, _ args: [String]) -> Int64 {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { fatalError(String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, a) in args.enumerated() { sqlite3_bind_text(stmt, Int32(i + 1), a, -1, transient) }
        guard sqlite3_step(stmt) == SQLITE_DONE else { fatalError(String(cString: sqlite3_errmsg(db))) }
        return sqlite3_last_insert_rowid(db)
    }

    func mailbox(_ url: String) -> Int64 { rowid("INSERT INTO mailboxes (url) VALUES (?)", [url]) }

    @discardableResult
    func message(mailbox: Int64, subject: String, address: String, name: String? = nil, received: Int, read: Bool = false, flagged: Bool = false,
                 deleted: Bool = false, messageId: String? = nil) -> Int64 {
        let s = rowid("INSERT INTO subjects (subject) VALUES (?)", [subject])
        let a = rowid("INSERT INTO addresses (address, comment) VALUES (?, ?)", [address, name ?? ""])
        let g = messageId.map { rowid("INSERT INTO message_global_data (message_id_header) VALUES (?)", [$0]) }
        exec("INSERT INTO messages (subject, sender, date_received, mailbox, read, flagged, deleted, global_message_id) VALUES (\(s), \(a), \(received), \(mailbox), \(read ? 1 : 0), \(flagged ? 1 : 0), \(deleted ? 1 : 0), \(g.map(String.init) ?? "NULL"))")
        return sqlite3_last_insert_rowid(db)
    }
}

struct MailEnvelopeIndexTests {
    static let acct1 = "11111111-AAAA-4444-8888-000000000001"
    static let acct2 = "22222222-BBBB-4444-8888-000000000002"
    static let t0 = 1_792_000_000 // 2026-10-14

    /// Two accounts, an inbox each, a Gmail-style nested folder, and a deleted message.
    func fixture() -> (MailIndexFixture, MailEnvelopeIndex) {
        let f = MailIndexFixture()
        let in1 = f.mailbox("imap://\(Self.acct1)/INBOX")
        let in2 = f.mailbox("ews://\(Self.acct2)/Inbox")
        let all = f.mailbox("imap://\(Self.acct1)/%5BGmail%5D/All%20Mail")
        f.message(mailbox: in1, subject: "Invoice October", address: "billing@acme.example", name: "Acme Billing", received: Self.t0 + 100, messageId: "<inv.1@acme.example>")
        f.message(mailbox: in1, subject: "Lunch?", address: "dana@example.com", received: Self.t0 + 300, read: true, flagged: true)
        f.message(mailbox: in2, subject: "Quarterly report", address: "boss@corp.example", name: "The Boss", received: Self.t0 + 200)
        f.message(mailbox: in2, subject: "Gone", address: "x@corp.example", received: Self.t0 + 400, deleted: true)
        f.message(mailbox: all, subject: "Archived invoice", address: "billing@acme.example", received: Self.t0 + 50)
        return (f, try! MailEnvelopeIndex(path: f.path))
    }

    func far() -> Date { Date().addingTimeInterval(60) }

    @Test func listsTheInboxOfEveryAccountNewestFirstWithoutDeletedMessages() throws {
        let (_, idx) = fixture()
        let r = try idx.search(MailSearchFilter(), mailbox: nil, accountId: nil, limit: 10,
                               accountNames: [Self.acct1: "iCloud", Self.acct2: "Work"], deadline: far())
        #expect(r.source == "index" && !r.truncated)
        #expect(r.messages.map(\.subject) == ["Lunch?", "Quarterly report", "Invoice October"])
        #expect(r.messages.map(\.account) == ["iCloud", "Work", "iCloud"])
        #expect(r.messages.map(\.mailbox) == ["INBOX", "Inbox", "INBOX"])
        #expect(r.messages[0].read && r.messages[0].flagged == true)
    }

    @Test func formatsSenderDateAndLink() throws {
        let (_, idx) = fixture()
        let r = try idx.search(MailSearchFilter(query: "invoice"), mailbox: nil, accountId: nil, limit: 10, deadline: far())
        let m = try #require(r.messages.first)
        #expect(m.from == "Acme Billing <billing@acme.example>")
        #expect(m.date == AppleDates.string(Date(timeIntervalSince1970: TimeInterval(Self.t0 + 100))))
        #expect(m.link == MailWave1.link(messageId: "<inv.1@acme.example>") && m.account == "")
        // No name: the bare address. No Message-ID header: no link.
        let dana = try idx.search(MailSearchFilter(from: "dana"), mailbox: nil, accountId: nil, limit: 10, deadline: far()).messages[0]
        #expect(dana.from == "dana@example.com" && dana.link == nil)
    }

    @Test func limitCapsTheNewest() throws {
        let (_, idx) = fixture()
        let r = try idx.search(MailSearchFilter(), mailbox: nil, accountId: nil, limit: 2, deadline: far())
        #expect(r.messages.map(\.subject) == ["Lunch?", "Quarterly report"])
    }

    @Test func filtersByTextSenderReadStateAndDates() throws {
        let (_, idx) = fixture()
        func subjects(_ f: MailSearchFilter) throws -> [String] {
            try idx.search(f, mailbox: nil, accountId: nil, limit: 10, deadline: far()).messages.map(\.subject)
        }
        #expect(try subjects(MailSearchFilter(query: "QUARTERLY")) == ["Quarterly report"])
        #expect(try subjects(MailSearchFilter(query: "boss")) == ["Quarterly report"]) // the sender's name
        #expect(try subjects(MailSearchFilter(from: "acme")) == ["Invoice October"])
        #expect(try subjects(MailSearchFilter(unread: true)) == ["Quarterly report", "Invoice October"])
        #expect(try subjects(MailSearchFilter(unread: false)) == ["Lunch?"])
        let since = Date(timeIntervalSince1970: TimeInterval(Self.t0 + 150))
        let until = Date(timeIntervalSince1970: TimeInterval(Self.t0 + 250))
        #expect(try subjects(MailSearchFilter(since: since)) == ["Lunch?", "Quarterly report"])
        #expect(try subjects(MailSearchFilter(since: since, until: until)) == ["Quarterly report"])
        // A `%` or `_` typed by the model is text, not a wildcard.
        #expect(try subjects(MailSearchFilter(query: "%")) == [])
    }

    @Test func searchesANamedMailboxAndNarrowsByAccount() throws {
        let (_, idx) = fixture()
        let all = try idx.search(MailSearchFilter(), mailbox: "[Gmail]/All Mail", accountId: nil, limit: 10, deadline: far())
        #expect(all.messages.map(\.subject) == ["Archived invoice"] && all.messages[0].mailbox == "[Gmail]/All Mail")
        let work = try idx.search(MailSearchFilter(), mailbox: "inbox", accountId: Self.acct2.lowercased(), limit: 10, deadline: far())
        #expect(work.messages.map(\.subject) == ["Quarterly report"])
        #expect(throws: MailIndexError.unknownAccount) {
            _ = try idx.search(MailSearchFilter(), mailbox: nil, accountId: "no-such-account", limit: 10, deadline: far())
        }
        let none = try idx.search(MailSearchFilter(), mailbox: "Nope", accountId: nil, limit: 10, deadline: far())
        #expect(none.messages.isEmpty && !none.truncated)
    }

    @Test func aMissingOptionalColumnStillSearches() throws {
        let f = MailIndexFixture(deleted: false, globalData: false)
        let box = f.mailbox("imap://\(Self.acct1)/INBOX")
        f.exec("INSERT INTO subjects (subject) VALUES ('Hello')")
        f.exec("INSERT INTO addresses (address, comment) VALUES ('a@b.example', '')")
        f.exec("INSERT INTO messages (subject, sender, date_received, mailbox) VALUES (1, 1, \(Self.t0), \(box))")
        let r = try MailEnvelopeIndex(path: f.path).search(MailSearchFilter(), mailbox: nil, accountId: nil, limit: 5, deadline: far())
        #expect(r.messages.map(\.subject) == ["Hello"] && r.messages[0].link == nil)
    }

    @Test func anUnknownSchemaIsUnreadableNotACrash() {
        let f = MailIndexFixture(schemaOK: false)
        #expect(throws: MailIndexError.self) { _ = try MailEnvelopeIndex(path: f.path) }
    }

    @Test func aSlowScanStopsAtItsDeadlineWithThePartialAnswer() throws {
        let f = MailIndexFixture()
        let box = f.mailbox("imap://\(Self.acct1)/INBOX")
        f.exec("INSERT INTO addresses (address, comment) VALUES ('a@b.example', '')")
        f.exec("INSERT INTO subjects (subject) VALUES ('s')")
        f.exec("BEGIN")
        for i in 0..<20_000 { f.exec("INSERT INTO messages (subject, sender, date_received, mailbox) VALUES (1, 1, \(Self.t0 + i), \(box))") }
        f.exec("COMMIT")
        let idx = try MailEnvelopeIndex(path: f.path)
        // A deadline already past: SQLite is interrupted at its first progress check.
        let late = try idx.search(MailSearchFilter(query: "zzz"), mailbox: nil, accountId: nil, limit: 10, deadline: Date().addingTimeInterval(-1))
        #expect(late.truncated && late.source == "index")
        #expect(late.note?.contains("Narrow") == true)
        // The same query with room finishes, whole.
        let whole = try idx.search(MailSearchFilter(), mailbox: nil, accountId: nil, limit: 10, deadline: far())
        #expect(!whole.truncated && whole.messages.count == 10 && whole.note == nil)
    }

    @Test func findsTheNewestVersionFolder() throws {
        let home = NSTemporaryDirectory() + "psyche-mailhome-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: home) }
        #expect(throws: MailIndexError.missing) { _ = try MailEnvelopeIndex.defaultPath(home: home) }
        for v in ["V9", "V10"] {
            try FileManager.default.createDirectory(atPath: "\(home)/Library/Mail/\(v)/MailData", withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: "\(home)/Library/Mail/\(v)/MailData/Envelope Index", contents: Data())
        }
        try FileManager.default.createDirectory(atPath: "\(home)/Library/Mail/Bundles", withIntermediateDirectories: true)
        #expect(try MailEnvelopeIndex.defaultPath(home: home) == "\(home)/Library/Mail/V10/MailData/Envelope Index")
    }

    @Test func mailboxURLsBecomeAccountAndPath() throws {
        let m = try #require(MailEnvelopeIndex.Mailbox(rowid: 1, url: "imap://AB-12/Clients/Acme%20Co"))
        #expect(m.accountId == "AB-12" && m.path == "Clients/Acme Co" && !m.isInbox)
        #expect(MailEnvelopeIndex.Mailbox(rowid: 2, url: "ews://X/Inbox")?.isInbox == true)
        #expect(MailEnvelopeIndex.Mailbox(rowid: 3, url: "not a url") == nil)
    }
}
