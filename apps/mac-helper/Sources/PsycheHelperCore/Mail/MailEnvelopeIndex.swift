import Foundation
import SQLite3

/// What `mail.search` returns: the messages plus how the answer was reached, so a partial or
/// narrowed search says so instead of looking complete.
public struct MailSearchResult: Sendable, Equatable {
    public var messages: [MailSummaryRecord]
    /// The search stopped at its deadline: these are the newest matches found, there may be more.
    public var truncated: Bool
    /// `index` (Mail's local Envelope Index) or `mail` (a bounded AppleScript query).
    public var source: String
    /// Plain-language scope or limits, e.g. "Searched the inbox, last 30 days".
    public var note: String?

    public init(messages: [MailSummaryRecord], truncated: Bool = false, source: String = "mail", note: String? = nil) {
        self.messages = messages
        self.truncated = truncated
        self.source = source
        self.note = note
    }
}

public enum MailIndexError: Error, Sendable, Equatable {
    /// Mail has no index here (never signed in, or another layout).
    case missing
    /// Reading `~/Library/Mail` needs Full Disk Access.
    case noAccess
    /// Locked, corrupt or a schema this reader does not know.
    case unreadable(String)
    /// `account` has no mailboxes in the index (or its name could not be resolved).
    case unknownAccount
}

/// Read-only queries over Mail's `Envelope Index` (`~/Library/Mail/V*/MailData`): subject, sender,
/// date, read / flagged state and mailbox of every message, answered in milliseconds. The AppleScript
/// `whose` clauses this replaces evaluate inside Mail, message by message, across every mailbox.
///
/// A message's AppleScript `id` is its `messages.ROWID`, so ids found here open with `mail.read`.
/// Bodies, recipients and attachments are not in the index; `mail.read` still goes through Mail.
public final class MailEnvelopeIndex: @unchecked Sendable {
    let db: SQLiteReader
    private let hasDeleted: Bool
    private let hasGlobalData: Bool

    /// `…/Library/Mail/V10/MailData/Envelope Index` for the newest `V*` folder, or nil when absent.
    public static func defaultPath(home: String = NSHomeDirectory()) throws -> String {
        let root = home + "/Library/Mail"
        let fm = FileManager.default
        guard fm.fileExists(atPath: root) else { throw MailIndexError.missing }
        guard let entries = try? fm.contentsOfDirectory(atPath: root) else { throw MailIndexError.noAccess }
        let versions = entries.compactMap { name -> (Int, String)? in
            guard name.hasPrefix("V"), let n = Int(name.dropFirst()) else { return nil }
            return (n, name)
        }.sorted { $0.0 > $1.0 }
        for (_, name) in versions {
            let path = "\(root)/\(name)/MailData/Envelope Index"
            if fm.fileExists(atPath: path) { return path }
        }
        throw MailIndexError.missing
    }

    public convenience init(home: String = NSHomeDirectory()) throws {
        try self.init(path: try Self.defaultPath(home: home))
    }

    /// Opens read-only. A database that is busy (Mail mid-checkpoint) or whose write-ahead log
    /// cannot be shared is read as an immutable snapshot, possibly a little behind Mail.
    public init(path: String) throws {
        let reader: SQLiteReader
        do {
            do {
                reader = try SQLiteReader(path: path)
            } catch let e as SQLiteReader.OpenError where !e.isPermission {
                reader = try SQLiteReader(path: path, immutable: true)
            }
            let messages = try reader.columns("messages")
            guard ["subject", "sender", "date_received", "mailbox", "read", "flagged"].allSatisfy(messages.contains),
                  try reader.columns("mailboxes").contains("url"),
                  try reader.columns("subjects").contains("subject"),
                  try reader.columns("addresses").contains("address")
            else { throw MailIndexError.unreadable("unexpected schema") }
            db = reader
            hasDeleted = messages.contains("deleted")
            hasGlobalData = messages.contains("global_message_id")
                && ((try? reader.columns("message_global_data").contains("message_id_header")) ?? false)
        } catch let e as SQLiteReader.OpenError {
            throw e.isPermission ? MailIndexError.noAccess : MailIndexError.unreadable(e.message)
        } catch let e as SQLiteReader.QueryError {
            throw e.code == SQLITE_AUTH || e.code == SQLITE_PERM || e.code == SQLITE_CANTOPEN ? MailIndexError.noAccess : MailIndexError.unreadable(e.message)
        }
    }

    // MARK: Mailboxes

    /// A mailbox row: `imap://<account UUID>/Parent/Child` → account UUID and `Parent/Child`.
    public struct Mailbox: Sendable, Equatable {
        public var rowid: Int64
        public var accountId: String
        public var path: String

        public init?(rowid: Int64, url: String) {
            guard let schemeEnd = url.range(of: "://") else { return nil }
            let rest = url[schemeEnd.upperBound...]
            let host = rest.prefix { $0 != "/" }
            accountId = String(host).removingPercentEncoding ?? String(host)
            let p = rest.dropFirst(host.count).drop { $0 == "/" }
            path = String(p).removingPercentEncoding ?? String(p)
            self.rowid = rowid
        }

        public var isInbox: Bool { path.caseInsensitiveCompare("INBOX") == .orderedSame }
    }

    func mailboxes(_ deadline: Date) throws -> [Mailbox] {
        try guarded {
            try db.query("SELECT ROWID, url FROM mailboxes WHERE url IS NOT NULL", [], deadline: deadline).rows.compactMap { r in
                guard let id = r[0].int, let url = r[1].text else { return nil }
                return Mailbox(rowid: id, url: url)
            }
        }
    }

    // MARK: Search

    /// Newest-first matches, at most `limit`. `mailbox` nil is the inbox of every account;
    /// `accountId` (a mailbox-URL account UUID) narrows a named mailbox. Stops at `deadline` with
    /// what it has and `truncated` set. `accountNames` maps account UUIDs to Mail's account names.
    public func search(_ filter: MailSearchFilter, mailbox: String?, accountId: String?, limit: Int,
                       accountNames: [String: String] = [:], deadline: Date) throws -> MailSearchResult {
        let all = try mailboxes(deadline)
        let scope = all.filter { mb in
            if let accountId, mb.accountId.caseInsensitiveCompare(accountId) != .orderedSame { return false }
            if let mailbox, !mailbox.isEmpty { return mb.path.caseInsensitiveCompare(mailbox) == .orderedSame }
            return mb.isInbox
        }
        if scope.isEmpty {
            if let accountId, !all.contains(where: { $0.accountId.caseInsensitiveCompare(accountId) == .orderedSame }) { throw MailIndexError.unknownAccount }
            return MailSearchResult(messages: [], source: "index")
        }
        var sql = """
            SELECT m.ROWID, m.mailbox, COALESCE(s.subject, ''), COALESCE(a.address, ''), COALESCE(a.comment, ''),
                   m.date_received, m.read, m.flagged, \(hasGlobalData ? "COALESCE(g.message_id_header, '')" : "''")
            FROM messages m
            LEFT JOIN subjects s ON s.ROWID = m.subject
            LEFT JOIN addresses a ON a.ROWID = m.sender
            \(hasGlobalData ? "LEFT JOIN message_global_data g ON g.ROWID = m.global_message_id" : "")
            WHERE m.mailbox IN (\(scope.map { String($0.rowid) }.joined(separator: ",")))
            """
        var args: [SQLiteReader.Value] = []
        if hasDeleted { sql += " AND m.deleted = 0" }
        if let since = filter.since { sql += " AND m.date_received >= ?"; args.append(.int(Int64(since.timeIntervalSince1970))) }
        if let until = filter.until { sql += " AND m.date_received < ?"; args.append(.int(Int64(until.timeIntervalSince1970))) }
        if let unread = filter.unread { sql += " AND m.read = ?"; args.append(.int(unread ? 0 : 1)) }
        // instr(lower()) is a plain substring test: no LIKE wildcards in what the model typed.
        let q = filter.query.lowercased(), f = filter.from.lowercased()
        if !q.isEmpty {
            sql += " AND (instr(lower(s.subject), ?) > 0 OR instr(lower(a.address), ?) > 0 OR instr(lower(a.comment), ?) > 0)"
            args += [.text(q), .text(q), .text(q)]
        }
        if !f.isEmpty {
            sql += " AND (instr(lower(a.address), ?) > 0 OR instr(lower(a.comment), ?) > 0)"
            args += [.text(f), .text(f)]
        }
        sql += " ORDER BY m.date_received DESC LIMIT ?"
        args.append(.int(Int64(max(0, limit))))

        let byRowid = Dictionary(uniqueKeysWithValues: scope.map { ($0.rowid, $0) })
        let (rows, timedOut) = try guarded { try db.query(sql, args, deadline: deadline) }
        let messages = rows.compactMap { r -> MailSummaryRecord? in
            guard let id = r[0].int, let mbId = r[1].int, let mb = byRowid[mbId], let received = r[5].int else { return nil }
            let address = r[3].text ?? "", name = r[4].text ?? ""
            let sender = name.isEmpty || name == address ? address : (address.isEmpty ? name : "\(name) <\(address)>")
            return MailSummaryRecord(
                id: String(id), mailbox: mb.path, account: accountNames[mb.accountId] ?? "",
                subject: r[2].text ?? "", from: sender, date: AppleDates.string(Date(timeIntervalSince1970: TimeInterval(received))),
                read: (r[6].int ?? 0) != 0, flagged: (r[7].int ?? 0) != 0,
                link: (r[8].text).flatMap { $0.isEmpty ? nil : MailWave1.link(messageId: $0) })
        }
        return MailSearchResult(messages: messages, truncated: timedOut, source: "index",
                                note: timedOut ? "The search hit its time limit: these are the newest matches found. Narrow it by date, sender or mailbox." : nil)
    }

    private func guarded<T>(_ body: () throws -> T) throws -> T {
        do { return try body() } catch let e as SQLiteReader.QueryError { throw MailIndexError.unreadable(e.message) }
    }
}
