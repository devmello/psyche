import Foundation

/// Metadata-only Messages reads for the people graph (issue #763). Unlike `messages.chats` /
/// `messages.read` (agent/channel-facing, bodies included), these return who talked to whom and
/// when. No display names, services or guids beyond `chatId`; message text only when the caller
/// sets `includeText`, and in the default mode the SQL never selects `text` or `attributedBody`.
public enum GraphMessages {
    public struct ChatsParams: Decodable, Sendable { public var limit: Int? }
    public struct ReadParams: Decodable, Sendable {
        public var sinceCursor: Int?
        public var limit: Int?
        public var includeText: Bool?
    }
}

public struct GraphChat: Codable, Equatable, Sendable {
    public var chatId: String
    public var handles: [String]
    public var isGroup: Bool
}

public struct GraphChatsResult: Codable, Equatable, Sendable {
    public var chats: [GraphChat]
}

public enum GraphDirection: String, Codable, Sendable {
    case `in`
    case out
}

public struct GraphMessage: Codable, Equatable, Sendable {
    public var chatId: String
    /// The sender's normalized handle; present only for inbound messages.
    public var handle: String?
    public var sentAt: String
    public var direction: GraphDirection
    /// Present only when the caller asked for text.
    public var text: String?
}

public struct GraphReadResult: Codable, Equatable, Sendable {
    public var cursor: Int?
    public var hasMore: Bool
    public var messages: [GraphMessage]

    enum CodingKeys: String, CodingKey { case cursor, hasMore, messages }

    public init(cursor: Int?, hasMore: Bool, messages: [GraphMessage]) {
        self.cursor = cursor
        self.hasMore = hasMore
        self.messages = messages
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cursor = try c.decodeIfPresent(Int.self, forKey: .cursor)
        hasMore = try c.decode(Bool.self, forKey: .hasMore)
        messages = try c.decode([GraphMessage].self, forKey: .messages)
    }

    /// `cursor` is always written (JSON `null` when there is none).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let cursor { try c.encode(cursor, forKey: .cursor) } else { try c.encodeNil(forKey: .cursor) }
        try c.encode(hasMore, forKey: .hasMore)
        try c.encode(messages, forKey: .messages)
    }
}

extension ChatDatabase {
    /// Chats newest activity first with their participants' normalized handles (the owner is not
    /// in chat.db's participant list). No names, services or text.
    public func graphChats(limit: Int) throws -> GraphChatsResult {
        let rows = try run {
            try db.query("""
                SELECT c.ROWID, c.guid, c.style,
                       (SELECT MAX(message_id) FROM chat_message_join WHERE chat_id = c.ROWID) AS last_row
                FROM chat c
                ORDER BY last_row IS NULL, last_row DESC
                LIMIT ?1
                """, [.int(Int64(clamp(limit)))])
        }
        let chats = try rows.map { r -> GraphChat in
            let guid = r[1].text ?? ""
            let handles = try run {
                try db.query("""
                    SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
                    WHERE chj.chat_id = ? ORDER BY h.ROWID
                    """, [.int(r[0].int ?? 0)])
            }.compactMap { $0[0].text.map { Self.normalize(handle: $0) } }
            return GraphChat(chatId: guid, handles: handles, isGroup: Self.isGroup(guid: guid, style: r[2].int))
        }
        return GraphChatsResult(chats: chats)
    }

    /// With `since`, rows after it ascending (one page); without, the newest `limit` rows ascending.
    /// Reactions and rows not linked to a chat are skipped. When `includeText` is false the query
    /// does not name `m.text` or `m.attributedBody`, so bodies are never read from the database.
    public func graphRead(since: Int?, limit: Int, includeText: Bool) throws -> GraphReadResult {
        let limit = clamp(limit)
        let bodyColumns = includeText ? ", m.text, \(messageColumns.contains("attributedBody") ? "m.attributedBody" : "NULL")" : ""
        let notReaction = messageColumns.contains("associated_message_type")
            ? "AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)" : ""
        let sql = """
            SELECT m.ROWID, m.is_from_me, m.date, h.id, c.guid\(bodyColumns)
            FROM message m
            JOIN chat c ON c.ROWID = (SELECT MIN(chat_id) FROM chat_message_join WHERE message_id = m.ROWID)
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.ROWID > ?1 \(notReaction)
            ORDER BY m.ROWID \(since == nil ? "DESC" : "ASC")
            LIMIT ?2
            """
        var rows = try run { try db.query(sql, [.int(Int64(since ?? 0)), .int(Int64(limit + 1))]) }
        let hasMore = since != nil && rows.count > limit
        if rows.count > limit { rows.removeLast() }
        if since == nil { rows.reverse() }
        let messages = rows.map { r -> GraphMessage in
            let fromMe = (r[1].int ?? 0) != 0
            var text: String?
            if includeText {
                text = r[5].text
                if text == nil || text?.isEmpty == true, let body = r[6].blob { text = TypedStream.text(from: body) ?? text }
                text = text?.replacingOccurrences(of: "\u{FFFC}", with: "")
                if text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true { text = nil }
            }
            return GraphMessage(
                chatId: r[4].text ?? "",
                handle: fromMe ? nil : r[3].text.map { Self.normalize(handle: $0) },
                sentAt: Self.iso(appleDate: r[2]) ?? "1970-01-01T00:00:00.000Z",
                direction: fromMe ? .out : .in,
                text: text
            )
        }
        let last = rows.last?[0].int.map(Int.init)
        return GraphReadResult(cursor: last ?? since, hasMore: hasMore, messages: messages)
    }
}
