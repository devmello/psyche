import CryptoKit
import Foundation
import PsycheProtocol

// Notes wave 1 (docs/connectors/apple-apps-2026.md §4.4, N1–N5): pure pieces.

/// `AppleNoteFolder` (`notes.folders`).
public struct NoteFolderRecord: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var account: String
    public var parentId: String?
    public var noteCount: Int

    public init(id: String, name: String, account: String, parentId: String?, noteCount: Int) {
        self.id = id
        self.name = name
        self.account = account
        self.parentId = parentId
        self.noteCount = noteCount
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(account, forKey: .account)
        try c.encode(parentId, forKey: .parentId)
        try c.encode(noteCount, forKey: .noteCount)
    }

    /// Folders can come back twice (an account's folder list and a parent's); keep one, with its parent.
    public static func dedupe(_ xs: [NoteFolderRecord]) -> [NoteFolderRecord] {
        var byId: [String: NoteFolderRecord] = [:]
        var order: [String] = []
        for f in xs {
            if let old = byId[f.id] {
                if old.parentId == nil, f.parentId != nil { byId[f.id] = f }
            } else {
                byId[f.id] = f
                order.append(f.id)
            }
        }
        return order.compactMap { byId[$0] }
    }
}

public enum NotesWave1 {
    /// sha256 of the body HTML as Notes returns it: what `notes.update` binds to.
    public static func bodyHash(_ html: String) -> String {
        SHA256.hash(data: Data(html.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Text around the first match of `query` (or the start), on one line, at most ~`radius`*2.
    public static func snippet(_ text: String, query: String, radius: Int = 80) -> String {
        let flat = text.split(whereSeparator: { $0.isNewline }).joined(separator: " ")
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, let r = flat.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) else {
            return String(flat.prefix(radius * 2)).trimmingCharacters(in: .whitespaces)
        }
        let start = flat.index(r.lowerBound, offsetBy: -radius, limitedBy: flat.startIndex) ?? flat.startIndex
        let end = flat.index(r.upperBound, offsetBy: radius, limitedBy: flat.endIndex) ?? flat.endIndex
        var s = String(flat[start..<end]).trimmingCharacters(in: .whitespaces)
        if start > flat.startIndex { s = "…" + s }
        if end < flat.endIndex { s += "…" }
        return s
    }

    /// HTML appended to a note (N3): one escaped `<div>` per line; a checklist puts "☐ " before
    /// each line (Notes' real checklists cannot be made through scripting: that is wave 2's shortcut).
    public static func appendHTML(_ text: String, checklist: Bool) -> String {
        text.components(separatedBy: .newlines).map { line -> String in
            let t = NotesHTML.escape(line)
            if checklist { return t.trimmingCharacters(in: .whitespaces).isEmpty ? "" : "<div>☐ \(t)</div>" }
            return "<div>\(t.isEmpty ? "<br>" : t)</div>"
        }.joined()
    }

    /// Notes ids are `x-coredata://…`.
    public static func checkId(_ id: String, field: String = "id") throws {
        guard id.hasPrefix("x-coredata://"), id.count <= 300 else { throw CapabilityError.invalidParams("\(field) is a Notes id (x-coredata://…)", field: field) }
    }

    /// Newest modified first, from the script's `id, modified` pairs.
    public static func newest(_ pairs: [[String]], limit: Int) -> [String] { MailSearchFilter.newest(pairs, limit: limit) }
}

/// A small Markdown subset → Notes HTML (N5): `#`–`###` headings, `-` / `*` / `1.` lists, `**bold**`,
/// `*italic*`, `` `code` ``, `[text](https://…)` links. Everything else is escaped text; no raw HTML.
public enum NotesMarkdown {
    public static func html(title: String, markdown: String) -> String {
        var out = "<div><h1>\(NotesHTML.escape(title))</h1></div>"
        var list: String?  // "ul" / "ol" while in a list
        func close() {
            if let l = list { out += "</\(l)>"; list = nil }
        }
        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if let (level, text) = heading(line) {
                close()
                out += "<div><h\(level)>\(inline(text))</h\(level)></div>"
            } else if let item = bullet(line) {
                if list != "ul" { close(); out += "<ul>"; list = "ul" }
                out += "<li>\(inline(item))</li>"
            } else if let item = numbered(line) {
                if list != "ol" { close(); out += "<ol>"; list = "ol" }
                out += "<li>\(inline(item))</li>"
            } else {
                close()
                out += line.isEmpty ? "<div><br></div>" : "<div>\(inline(line))</div>"
            }
        }
        close()
        return out
    }

    static func heading(_ l: String) -> (Int, String)? {
        for n in (1...3).reversed() {
            let p = String(repeating: "#", count: n) + " "
            if l.hasPrefix(p) { return (min(3, n + 1), String(l.dropFirst(p.count))) }  // h1 is the title
        }
        return nil
    }

    static func bullet(_ l: String) -> String? {
        for p in ["- ", "* ", "+ "] where l.hasPrefix(p) { return String(l.dropFirst(2)) }
        return nil
    }

    static func numbered(_ l: String) -> String? {
        guard let dot = l.firstIndex(of: "."), l[..<dot].allSatisfy(\.isNumber), !l[..<dot].isEmpty,
              l[l.index(after: dot)...].hasPrefix(" ") else { return nil }
        return String(l[l.index(dot, offsetBy: 2)...])
    }

    /// Escapes first, then applies inline marks to the escaped text (so nothing becomes raw HTML).
    static func inline(_ s: String) -> String {
        var t = NotesHTML.escape(s)
        t = replace(t, #"`([^`]+)`"#) { "<tt>\($0[1])</tt>" }
        t = replace(t, #"\*\*([^*]+)\*\*"#) { "<b>\($0[1])</b>" }
        t = replace(t, #"(?<![*\w])\*([^*]+)\*(?![*\w])"#) { "<i>\($0[1])</i>" }
        t = replace(t, #"\[([^\]]+)\]\((https?://[^\s)&]+(?:&amp;[^\s)&]+)*)\)"#) { "<a href=\"\($0[2])\">\($0[1])</a>" }
        return t
    }

    static func replace(_ s: String, _ pattern: String, _ f: ([String]) -> String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return s }
        let ns = s as NSString
        var out = ""
        var last = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let groups = (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
            out += f(groups)
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }
}
