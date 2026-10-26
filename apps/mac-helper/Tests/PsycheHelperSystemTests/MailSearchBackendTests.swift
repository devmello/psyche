import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import SQLite3
import Testing

/// `MailScriptingBackend.searchBounded` on a fixture Envelope Index. The account lookup is
/// injected, so no Apple Event ever reaches the owner's Mail.
struct MailSearchBackendTests {
    private func makeIndex() -> String {
        let dir = NSTemporaryDirectory() + "psyche-mailbackend-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let path = dir + "/Envelope Index"
        var db: OpaquePointer?
        sqlite3_open(path, &db)
        defer { sqlite3_close(db) }
        sqlite3_exec(db, """
            CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
            CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
            CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
            CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, subject INTEGER, sender INTEGER, date_received INTEGER, mailbox INTEGER,
                                   read INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0);
            INSERT INTO subjects VALUES (1, 'Invoice'), (2, 'Lunch');
            INSERT INTO addresses VALUES (1, 'billing@example.com', 'Billing'), (2, 'dana@example.com', '');
            INSERT INTO mailboxes VALUES (1, 'imap://ACCT-1/INBOX'), (2, 'imap://ACCT-1/Archive');
            INSERT INTO messages (ROWID, subject, sender, date_received, mailbox) VALUES (10, 1, 1, 1792000100, 1), (11, 2, 2, 1792000200, 1), (12, 1, 1, 1792000300, 2);
            """, nil, nil, nil)
        return path
    }

    @Test func answersFromTheIndexWithoutTouchingMail() async throws {
        let path = makeIndex()
        let b = MailScriptingBackend(indexPath: { path }, accountLookup: { ["ACCT-1": "iCloud"] })
        let r = try await b.searchBounded(MailSearchFilter(query: "invoice"), mailbox: nil, account: nil, limit: 5)
        #expect(r.source == "index" && !r.truncated)
        #expect(r.messages.map(\.id) == ["10"] && r.messages[0].account == "iCloud" && r.messages[0].mailbox == "INBOX")
        // A named account is resolved through the lookup, a named mailbox through the index.
        let archive = try await b.searchBounded(MailSearchFilter(), mailbox: "Archive", account: "iCloud", limit: 5)
        #expect(archive.messages.map(\.id) == ["12"])
        // The plain `search` is the same answer.
        #expect(try await b.search(MailSearchFilter(), mailbox: nil, account: nil, limit: 5).map(\.id) == ["11", "10"])
    }
}
