import CryptoKit
import Foundation
import PsycheProtocol

// Mail wave 1 (docs/connectors/apple-apps-2026.md §4.1, M2–M9): pure pieces of the Mail adapter.

/// `AppleMailMailbox` (`mail.mailboxes`, M2). `account` is empty for the unified inbox; nested
/// mailboxes are named `Parent/Child`.
public struct MailboxRecord: Codable, Sendable, Equatable {
    public var account: String
    public var name: String
    public var unreadCount: Int
    public var special: String?

    public init(account: String, name: String, unreadCount: Int, special: String? = nil) {
        self.account = account
        self.name = name
        self.unreadCount = unreadCount
        self.special = special ?? MailWave1.special(name)
    }

    /// `special` is a required key (null when the mailbox has no role).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(account, forKey: .account)
        try c.encode(name, forKey: .name)
        try c.encode(unreadCount, forKey: .unreadCount)
        try c.encode(special, forKey: .special)
    }
}

/// `AppleMailDraftRef` (plus the body, for the approval card): a saved draft still open in Mail.
public struct MailDraftRecord: Codable, Sendable, Equatable {
    public var draftId: String
    public var subject: String
    public var to: [String]
    public var cc: [String]
    public var body: String
    public var bodySha256: String

    public init(draftId: String, subject: String, to: [String], cc: [String], body: String) {
        self.draftId = draftId
        self.subject = subject
        self.to = to
        self.cc = cc
        self.body = body
        self.bodySha256 = MailWave1.bodyHash(body)
    }
}

/// What the approval covered (`AppleMailSendDraftParams` minus the id): the send goes ahead only
/// if the draft still has exactly these recipients, subject and body.
public struct MailDraftExpectation: Codable, Sendable, Equatable {
    public var to: [String]
    public var cc: [String]?
    public var subject: String
    public var bodySha256: String

    public init(to: [String], cc: [String]?, subject: String, bodySha256: String) {
        self.to = to
        self.cc = cc
        self.subject = subject
        self.bodySha256 = bodySha256
    }
}

/// `AppleSavedFile`: `path` in a granted folder, or for the Library `stagedPath` (the Gateway
/// imports it and fills `libraryItemId`).
public struct MailSavedFileRecord: Codable, Sendable, Equatable {
    public var name: String
    public var size: Int
    public var path: String?
    public var libraryItemId: String?
    public var stagedPath: String?
    public var mimeType: String?

    public init(name: String, size: Int, path: String?, stagedPath: String? = nil, mimeType: String? = nil) {
        self.name = name
        self.size = size
        self.path = path
        self.libraryItemId = nil
        self.stagedPath = stagedPath
        self.mimeType = mimeType
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(size, forKey: .size)
        try c.encode(path, forKey: .path)
        try c.encode(libraryItemId, forKey: .libraryItemId)
        try c.encodeIfPresent(stagedPath, forKey: .stagedPath)
        try c.encodeIfPresent(mimeType, forKey: .mimeType)
    }
}

public enum MailWave1 {
    public static let maxBatch = 100
    public static let maxAttachments = 50

    /// Mail's `flag index` 0–6: red, orange, yellow, green, blue, purple, gray.
    public static let flagColors = 0...6

    /// The role of a mailbox from its (leaf) name, as providers name them.
    public static func special(_ name: String) -> String? {
        let leaf = (name.split(separator: "/").last.map(String.init) ?? name).lowercased()
        switch leaf {
        case "inbox": return "inbox"
        case "sent", "sent messages", "sent items", "sent mail": return "sent"
        case "drafts": return "drafts"
        case "junk", "spam", "junk e-mail", "junk email": return "junk"
        case "trash", "deleted items", "deleted messages", "bin": return "trash"
        case "archive", "all mail": return "archive"
        default: return nil
        }
    }

    /// `message://%3C<Message-ID>%3E`: opens the message in Mail from a reminder or a note.
    public static func link(messageId: String) -> String? {
        var id = messageId.trimmingCharacters(in: .whitespacesAndNewlines)
        if id.hasPrefix("<") { id.removeFirst() }
        if id.hasSuffix(">") { id.removeLast() }
        guard !id.isEmpty, id.count <= 998, !id.contains(where: { $0.isWhitespace || $0 == "<" || $0 == ">" }) else { return nil }
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "%/?#")
        guard let enc = id.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return "message://%3C\(enc)%3E"
    }

    /// Message ids for a batch: Mail's numeric ids, 1–100, no duplicates.
    public static func batch(_ ids: [String], field: String = "ids") throws -> [String] {
        guard !ids.isEmpty, ids.count <= maxBatch else {
            throw CapabilityError.invalidParams("\(field) takes 1–\(maxBatch) message ids", field: field)
        }
        guard ids.allSatisfy({ Int($0) != nil }) else { throw CapabilityError.invalidParams("each id is a Mail message id", field: field) }
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }

    /// SHA-256 of the body with line endings normalized (Mail stores CR, the model sends LF).
    public static func bodyHash(_ body: String) -> String {
        let normalized = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func addresses(_ xs: [String]) -> [String] { xs.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.sorted() }

    /// Throws `binding_mismatch` naming what changed since the approval.
    public static func check(_ draft: MailDraftRecord, against e: MailDraftExpectation) throws {
        var changed: [String] = []
        if addresses(draft.to) != addresses(e.to) { changed.append("to") }
        if let cc = e.cc, addresses(draft.cc) != addresses(cc) { changed.append("cc") }
        if e.cc == nil, !draft.cc.isEmpty { changed.append("cc") }
        if draft.subject != e.subject { changed.append("subject") }
        if draft.bodySha256 != e.bodySha256.lowercased() { changed.append("body") }
        guard changed.isEmpty else {
            throw CapabilityError(.bindingMismatch, reason: "draft_changed",
                                  "The draft changed after it was approved (\(changed.joined(separator: ", "))). Approve the new version.",
                                  details: ["changed": .array(changed.map { .string($0) })])
        }
    }

    /// A file name for an attachment saved into `existing` names: no path separators, no leading
    /// dot, no control characters, at most 200 characters, and unique (`name (2).pdf`).
    public static func fileName(_ raw: String, existing: Set<String>) -> String {
        var name = String(raw.unicodeScalars.map { s -> Character in
            if s == "/" || s == ":" || s == "\\" || s.properties.generalCategory == .control || s.properties.generalCategory == .format { return "_" }
            return Character(s)
        }).trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasPrefix(".") { name.removeFirst() }
        if name.isEmpty || name == ".." { name = "attachment" }
        if name.count > 200 {
            let ext = (name as NSString).pathExtension
            let base = String((name as NSString).deletingPathExtension.prefix(200 - ext.count - 1))
            name = ext.isEmpty ? String(name.prefix(200)) : base + "." + ext
        }
        let lower = Set(existing.map { $0.lowercased() })
        guard lower.contains(name.lowercased()) else { return name }
        let ext = (name as NSString).pathExtension
        let base = (name as NSString).deletingPathExtension
        var n = 2
        while true {
            let candidate = ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)"
            if !lower.contains(candidate.lowercased()) { return candidate }
            n += 1
        }
    }

    /// Where `mail.move` puts messages: a named mailbox of an account, or the account's Archive / Junk.
    public enum Destination: Equatable, Sendable {
        case mailbox(name: String, account: String)
        case archive
        case junk

        /// `AppleMailMoveParams.to`: "archive" / "junk", or {mailbox, account}.
        public static func parse(_ to: JSONValue?) throws -> Destination {
            if let s = to?.stringValue {
                switch s {
                case "archive": return .archive
                case "junk": return .junk
                default: throw CapabilityError.invalidParams("to is archive, junk or {mailbox, account} (deleting is a separate capability)", field: "to")
                }
            }
            guard let m = to?["mailbox"]?.stringValue, !m.isEmpty, let a = to?["account"]?.stringValue, !a.isEmpty else {
                throw CapabilityError.invalidParams("to is archive, junk or {mailbox, account}", field: "to")
            }
            return .mailbox(name: m, account: a)
        }

        /// Script arguments: kind, mailbox name, account name.
        public var scriptArgs: [String] {
            switch self {
            case .mailbox(let n, let a): ["mailbox", n, a]
            case .archive: ["archive", "", ""]
            case .junk: ["junk", "", ""]
            }
        }
    }

    /// Newest first by the `date` field of summary records.
    public static func newestFirst(_ xs: [MailSummaryRecord]) -> [MailSummaryRecord] {
        xs.sorted { $0.date > $1.date }
    }
}
