import Foundation
import SQLite3

/// Builds fixture chat.db files with the tables and columns Messages uses (J7 tests). `modern`
/// adds the columns newer macOS versions have (`thread_originator_guid`, `date_edited`,
/// `associated_message_emoji`, `is_sticker`); without it the schema is the macOS 12-era subset.
final class ChatDBFixture: @unchecked Sendable {
    let path: String
    private var db: OpaquePointer?
    let modern: Bool

    init(modern: Bool = true) {
        let dir = NSTemporaryDirectory() + "psyche-chatdb-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        path = dir + "/chat.db"
        self.modern = modern
        sqlite3_open(path, &db)
        let extraMessage = modern
            ? ", thread_originator_guid TEXT, date_edited INTEGER DEFAULT 0, associated_message_emoji TEXT"
            : ""
        exec("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT NOT NULL);
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
                               chat_identifier TEXT, service_name TEXT, display_name TEXT);
            CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT,
                                  attributedBody BLOB, handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER,
                                  is_from_me INTEGER DEFAULT 0, associated_message_guid TEXT,
                                  associated_message_type INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0\(extraMessage));
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0);
            CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, filename TEXT,
                                     uti TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER DEFAULT 0\(modern ? ", is_sticker INTEGER DEFAULT 0" : ""));
            CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
            """)
    }

    deinit { sqlite3_close(db) }

    func exec(_ sql: String) {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            fatalError("fixture SQL failed: \(err.map { String(cString: $0) } ?? "?")\n\(sql)")
        }
    }

    @discardableResult
    func insert(_ sql: String, _ args: [Any?]) -> Int64 {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { fatalError(String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as Int64: sqlite3_bind_int64(stmt, idx, v)
            case let v as String: sqlite3_bind_text(stmt, idx, v, -1, transient)
            case let v as Data: _ = v.withUnsafeBytes { sqlite3_bind_blob(stmt, idx, $0.baseAddress, Int32(v.count), transient) }
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        guard sqlite3_step(stmt) == SQLITE_DONE else { fatalError(String(cString: sqlite3_errmsg(db))) }
        return sqlite3_last_insert_rowid(db)
    }

    @discardableResult
    func handle(_ id: String, service: String = "iMessage") -> Int64 {
        insert("INSERT INTO handle (id, service) VALUES (?, ?)", [id, service])
    }

    @discardableResult
    func chat(_ guid: String, style: Int = 45, identifier: String, service: String = "iMessage", name: String? = nil, handles: [Int64]) -> Int64 {
        let id = insert("INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?)",
                        [guid, style, identifier, service, name])
        for h in handles { insert("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)", [id, h]) }
        return id
    }

    /// `date` is seconds after 2001-01-01, stored as nanoseconds like macOS 10.13+.
    @discardableResult
    func message(chat: Int64, handle: Int64 = 0, text: String?, body: Data? = nil, fromMe: Bool = false,
                 service: String = "iMessage", date: Int64 = 783_000_000, reactionType: Int = 0,
                 reactionTarget: String? = nil, audio: Bool = false, replyTo: String? = nil, edited: Int64 = 0) -> Int64 {
        let guid = UUID().uuidString
        let rowid: Int64
        if modern {
            rowid = insert("""
                INSERT INTO message (guid, text, attributedBody, handle_id, service, date, is_from_me, associated_message_type,
                                     associated_message_guid, is_audio_message, thread_originator_guid, date_edited)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, [guid, text, body, handle, service, date * 1_000_000_000, fromMe ? 1 : 0, reactionType, reactionTarget,
                      audio ? 1 : 0, replyTo, edited])
        } else {
            rowid = insert("""
                INSERT INTO message (guid, text, attributedBody, handle_id, service, date, is_from_me, associated_message_type,
                                     associated_message_guid, is_audio_message)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, [guid, text, body, handle, service, date * 1_000_000_000, fromMe ? 1 : 0, reactionType, reactionTarget, audio ? 1 : 0])
        }
        insert("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)", [chat, rowid])
        return rowid
    }

    func guid(of rowid: Int64) -> String {
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "SELECT guid FROM message WHERE ROWID = ?", -1, &stmt, nil)
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, rowid)
        sqlite3_step(stmt)
        return String(cString: sqlite3_column_text(stmt, 0))
    }

    func attach(_ message: Int64, name: String, uti: String, mime: String, bytes: Int) {
        let a = insert("INSERT INTO attachment (guid, filename, uti, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?, ?, ?)",
                       [UUID().uuidString, "~/Library/Messages/Attachments/xx/\(name)", uti, mime, name, bytes])
        insert("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)", [message, a])
    }
}
