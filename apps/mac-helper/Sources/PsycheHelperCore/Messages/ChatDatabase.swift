import Foundation
import PsycheProtocol

/// Read-only queries over Messages' `chat.db` (J7; security §12). Rows map to the protocol's
/// `MessagesChat` / `MessagesMessage`; the cursor is `message.ROWID`. Optional columns
/// (`thread_originator_guid`, `date_edited`, `associated_message_emoji`, `is_sticker`) are probed
/// once, so databases from macOS 15 through 27 read the same way. Attachments are metadata only.
public final class ChatDatabase: @unchecked Sendable {
    public static func defaultPath(home: String = NSHomeDirectory()) -> String {
        home + "/Library/Messages/chat.db"
    }

    public static let maxLimit = 200

    let db: SQLiteReader
    let messageColumns: Set<String>
    let attachmentColumns: Set<String>

    /// Opens `path` read-only. A permission failure becomes `forbidden/full_disk_access_missing`.
    public init(path: String) throws {
        guard FileManager.default.fileExists(atPath: path) else {
            // Without Full Disk Access, ~/Library/Messages exists but cannot be listed.
            let dir = (path as NSString).deletingLastPathComponent
            if FileManager.default.fileExists(atPath: dir), (try? FileManager.default.contentsOfDirectory(atPath: dir)) == nil {
                throw ChatDatabase.fullDiskAccessMissing
            }
            throw CapabilityError(.notFound, reason: "database_missing", "No Messages database at \(path); sign in to Messages first")
        }
        do {
            db = try SQLiteReader(path: path)
            messageColumns = try db.columns("message")
            attachmentColumns = try db.columns("attachment")
        } catch let e as SQLiteReader.OpenError where e.isPermission {
            throw ChatDatabase.fullDiskAccessMissing
        } catch let e as SQLiteReader.OpenError where e.isBusy {
            throw CapabilityError(.unavailable, reason: "database_locked", "The Messages database is busy", retryable: true)
        } catch {
            throw CapabilityError(.unavailable, reason: "database_unreadable", "The Messages database could not be read", retryable: true)
        }
        guard messageColumns.contains("guid"), messageColumns.contains("date") else {
            throw CapabilityError(.unavailable, reason: "database_unreadable", "The Messages database has an unexpected schema")
        }
    }

    public static let fullDiskAccessMissing = CapabilityError(
        .forbidden, reason: "full_disk_access_missing",
        "Psyche (Helper) needs Full Disk Access to read Messages. Turn it on in System Settings › Privacy & Security › Full Disk Access, then try again.",
        details: ["permission": "fullDiskAccess", "settingsURL": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]
    )

    // MARK: Queries

    public func lastCursor() throws -> Int? {
        try run { try db.query("SELECT MAX(ROWID) FROM message").first?.first?.int.map(Int.init) }
    }

    public func chats(limit: Int, query: String?) throws -> [MessagesChat] {
        let q: SQLiteReader.Value = query.map { .text($0.lowercased()) } ?? .null
        let rows = try run {
            try db.query("""
                SELECT c.ROWID, c.guid, c.service_name, c.display_name, c.style,
                       (SELECT MAX(message_id) FROM chat_message_join WHERE chat_id = c.ROWID) AS last_row
                FROM chat c
                WHERE ?1 IS NULL
                   OR instr(lower(ifnull(c.display_name, '')), ?1) > 0
                   OR instr(lower(ifnull(c.chat_identifier, '')), ?1) > 0
                   OR EXISTS (SELECT 1 FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
                              WHERE chj.chat_id = c.ROWID AND instr(lower(h.id), ?1) > 0)
                ORDER BY last_row IS NULL, last_row DESC
                LIMIT ?2
                """, [q, .int(Int64(clamp(limit)))])
        }
        return try rows.map { r in
            let rowid = r[0].int ?? 0
            let guid = r[1].text ?? ""
            let participants = try run {
                try db.query("""
                    SELECT h.id, h.service FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
                    WHERE chj.chat_id = ? ORDER BY h.ROWID
                    """, [.int(rowid)])
            }.map { MessagesHandle(handle: Self.normalize(handle: $0[0].text ?? ""), service: Self.service($0[1].text)) }
            let lastRow = r[5].int
            var lastAt: String?
            if let lastRow, let d = try run({ try db.query("SELECT date FROM message WHERE ROWID = ?", [.int(lastRow)]) }).first?.first {
                lastAt = Self.iso(appleDate: d)
            }
            let display = r[3].text.flatMap { $0.isEmpty ? nil : $0 }
            return MessagesChat(
                chatID: guid, displayName: display, isGroup: Self.isGroup(guid: guid, style: r[4].int),
                lastCursor: lastRow.map(Int.init), lastMessageAt: lastAt, participants: participants,
                service: Self.service(r[2].text, chatGuid: guid)
            )
        }
    }

    public struct ReadPage: Sendable {
        public var messages: [MessagesMessage]
        public var cursor: Int?
        public var hasMore: Bool
    }

    /// With `since`, rows after it ascending (one page); without, the newest `limit` rows ascending.
    public func read(chatId: String?, handle: String?, since: Int?, limit: Int, includeUnlinked: Bool = false) throws -> ReadPage {
        let limit = clamp(limit)
        let mc = messageColumns
        func col(_ name: String) -> String { mc.contains(name) ? "m.\(name)" : "NULL" }
        let sql = """
            SELECT m.ROWID, m.guid, m.text, \(col("attributedBody")), m.is_from_me, m.date, \(col("date_edited")),
                   \(col("service")), \(col("thread_originator_guid")), \(col("associated_message_type")),
                   \(col("associated_message_guid")), \(col("associated_message_emoji")), \(col("is_audio_message")),
                   h.id, h.service, c.guid, c.service_name, c.style
            FROM message m
            LEFT JOIN chat c ON c.ROWID = (
                CASE WHEN ?2 IS NULL THEN (SELECT MIN(chat_id) FROM chat_message_join WHERE message_id = m.ROWID)
                     ELSE (SELECT j.chat_id FROM chat_message_join j JOIN chat x ON x.ROWID = j.chat_id
                           WHERE j.message_id = m.ROWID AND x.guid = ?2) END)
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.ROWID > ?1
              AND (?2 IS NULL OR c.guid IS NOT NULL)
              AND (?3 IS NULL OR h.id = ?3 OR c.chat_identifier = ?3)
            ORDER BY m.ROWID \(since == nil ? "DESC" : "ASC")
            LIMIT ?4
            """
        let handleArg: SQLiteReader.Value = handle.map { .text(Self.normalize(handle: $0)) } ?? .null
        var rows = try run {
            try db.query(sql, [.int(Int64(since ?? 0)), chatId.map { .text($0) } ?? .null, handleArg, .int(Int64(limit + 1))])
        }
        // `hasMore` means "newer rows after cursor"; the newest-N mode has none by definition.
        let hasMore = since != nil && rows.count > limit
        if rows.count > limit { rows.removeLast() }
        if since == nil { rows.reverse() }
        let attachments = try attachments(for: rows.compactMap { $0[0].int })
        let all = rows.map { message(from: $0, attachments: attachments) }
        // A row not (yet) linked to a chat has an empty chatId; the watcher decides about it.
        let messages = includeUnlinked ? all : all.filter { !$0.chatID.isEmpty }
        return ReadPage(messages: messages, cursor: all.last?.cursor ?? since, hasMore: hasMore)
    }

    /// The service of the newest message in a chat (macOS 26+ `any;` chats carry no service).
    public func lastService(chatId: String) throws -> MessagesService {
        let r = try run {
            try db.query("""
                SELECT m.service FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID
                JOIN chat c ON c.ROWID = j.chat_id WHERE c.guid = ? ORDER BY m.ROWID DESC LIMIT 1
                """, [.text(chatId)])
        }
        return Self.service(r.first?.first?.text, chatGuid: chatId)
    }

    public static func isoNow() -> String { ISO8601DateFormatter.psyche.string(from: Date()) }

    // MARK: Row mapping

    func message(from r: [SQLiteReader.Value], attachments: [Int64: [MessagesAttachment]]) -> MessagesMessage {
        let rowid = r[0].int ?? 0
        let fromMe = (r[4].int ?? 0) != 0
        var text = r[2].text
        if text == nil || text?.isEmpty == true, let body = r[3].blob { text = TypedStream.text(from: body) ?? text }
        // U+FFFC is the inline placeholder for an attachment; the attachment list carries it.
        if let t = text {
            let stripped = t.replacingOccurrences(of: "\u{FFFC}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            text = stripped.isEmpty && !(attachments[rowid] ?? []).isEmpty ? nil : t.replacingOccurrences(of: "\u{FFFC}", with: "")
        }
        let chatGuid = r[15].text ?? ""
        let service = Self.service(r[7].text ?? r[14].text ?? r[16].text, chatGuid: chatGuid)
        var atts = attachments[rowid] ?? []
        if (r[12].int ?? 0) != 0 {
            atts = atts.map { a in
                MessagesAttachment(filename: a.filename, id: a.id, isSticker: a.isSticker, isVoiceNote: true,
                                   mimeType: a.mimeType, totalBytes: a.totalBytes, uti: a.uti)
            }
        }
        let edited = r[6].int.flatMap { $0 == 0 ? nil : Self.iso(appleDate: .int($0)) }
        return MessagesMessage(
            attachments: atts, chatID: chatGuid, cursor: Int(rowid), editedAt: edited,
            guid: r[1].text ?? "", isFromMe: fromMe,
            reaction: Self.reaction(type: r[9].int, target: r[10].text, emoji: r[11].text),
            replyToGUID: r[8].text.flatMap { $0.isEmpty ? nil : $0 },
            sender: fromMe ? nil : r[13].text.map { MessagesHandle(handle: Self.normalize(handle: $0), service: Self.service(r[14].text ?? r[7].text)) },
            sentAt: Self.iso(appleDate: r[5]) ?? "1970-01-01T00:00:00.000Z", service: service, text: text
        )
    }

    func attachments(for rowids: [Int64]) throws -> [Int64: [MessagesAttachment]] {
        guard !rowids.isEmpty else { return [:] }
        let sticker = attachmentColumns.contains("is_sticker") ? "a.is_sticker" : "0"
        let placeholders = Array(repeating: "?", count: rowids.count).joined(separator: ",")
        let rows = try run {
            try db.query("""
                SELECT maj.message_id, a.guid, a.transfer_name, a.mime_type, a.uti, a.total_bytes, \(sticker)
                FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
                WHERE maj.message_id IN (\(placeholders)) ORDER BY a.ROWID
                """, rowids.map { .int($0) })
        }
        var out: [Int64: [MessagesAttachment]] = [:]
        for r in rows {
            let uti = r[4].text
            let mime = r[3].text
            let voice = uti == "com.apple.coreaudio-format" || mime == "audio/x-caf"
            out[r[0].int ?? 0, default: []].append(MessagesAttachment(
                filename: r[2].text, id: r[1].text ?? "", isSticker: (r[6].int ?? 0) != 0, isVoiceNote: voice,
                mimeType: mime, totalBytes: r[5].int.map(Int.init), uti: uti
            ))
        }
        return out
    }

    // MARK: Helpers

    func clamp(_ limit: Int) -> Int { max(1, min(limit, Self.maxLimit)) }

    func run<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch let e as SQLiteReader.QueryError {
            if e.isBusy { throw CapabilityError(.unavailable, reason: "database_locked", "The Messages database is busy", retryable: true) }
            throw CapabilityError(.unavailable, reason: "database_unreadable", "The Messages database could not be read", retryable: true)
        }
    }

    /// Apple epoch (2001-01-01) in nanoseconds since macOS 10.13, seconds before.
    public static func iso(appleDate: SQLiteReader.Value) -> String? {
        let raw: Double
        switch appleDate {
        case .int(let v): raw = Double(v)
        case .double(let v): raw = v
        default: return nil
        }
        let seconds = abs(raw) > 1e11 ? raw / 1e9 : raw
        return ISO8601DateFormatter.psyche.string(from: Date(timeIntervalSinceReferenceDate: seconds))
    }

    /// chat.db service names (`iMessage`, `SMS`, `RCS`); macOS 26+ chat GUIDs may start with `any;`.
    public static func service(_ name: String?, chatGuid: String? = nil) -> MessagesService {
        switch name?.lowercased() {
        case "imessage": return .imessage
        case "sms": return .sms
        case "rcs": return .rcs
        default:
            guard let prefix = chatGuid?.split(separator: ";").first?.lowercased(), prefix != "any" else { return .unknown }
            return service(prefix, chatGuid: nil)
        }
    }

    public static func normalize(handle: String) -> String {
        let h = handle.trimmingCharacters(in: .whitespaces)
        return h.contains("@") ? h.lowercased() : h
    }

    /// `chat.style` 43 is a group, 45 a 1:1 chat; GUIDs mark groups with `;+;`.
    static func isGroup(guid: String, style: Int64?) -> Bool {
        if let style { return style == 43 }
        return guid.contains(";+;")
    }

    /// Tapbacks: `associated_message_type` 2000–2006 add, 3000–3006 remove; the target guid is
    /// prefixed `p:<part>/` or `bp:`.
    static func reaction(type: Int64?, target: String?, emoji: String?) -> MessagesReaction? {
        guard let type, (2000...2006).contains(type) || (3000...3006).contains(type), let target else { return nil }
        let kinds: [MessagesReactionKind] = [.love, .like, .dislike, .laugh, .emphasize, .question, .emoji]
        let kind = kinds[Int(type % 1000)]
        var guid = target
        if let slash = guid.firstIndex(of: "/") { guid = String(guid[guid.index(after: slash)...]) }
        else if guid.hasPrefix("bp:") { guid = String(guid.dropFirst(3)) }
        return MessagesReaction(emoji: kind == .emoji ? emoji : nil, kind: kind, removed: type >= 3000, targetGUID: guid)
    }
}
