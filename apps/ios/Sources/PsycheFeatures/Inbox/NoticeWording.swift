import Foundation
import PsycheStore

/// Words a Gateway notice in the phone's language. The Gateway sends message ids next to its English text; an id
/// this build has a String Catalog entry for is shown in the owner's language, and anything else (an unknown id
/// from a newer Gateway, a notice without ids) shows the Gateway's English text.
enum NoticeWording {
    /// The keys this build words itself. Each one has an entry in `Localizable.xcstrings` in every language.
    static let knownKeys: Set<String> = [
        "notice.codeRun.held.title", "notice.codeRun.held.body",
        "notice.codeRun.changed.title", "notice.codeRun.changed.body",
        "notice.codeRun.partial.title", "notice.codeRun.partial.body",
        "notice.codeRun.recreated.title", "notice.codeRun.recreated.body",
        "notice.codeRun.incident.title", "notice.codeRun.incident.body",
        "notice.codeRun.unmoved.title", "notice.codeRun.unmoved.body",
        "notice.machine.added.title", "notice.machine.added.body",
        "notice.machine.removed.title", "notice.machine.removed.body",
        "notice.machine.offline.title", "notice.machine.offline.body",
        "notice.machine.scanIncomplete.title", "notice.machine.scanIncomplete.body",
        "notice.codeRun.unchecked.title", "notice.codeRun.unchecked.body",
        "notice.approvals.digest.body", "notice.attention.paused.title", "notice.attention.paused.body",
        "notice.browser.chrome.title", "notice.browser.chrome.body",
        "notice.browser.takeover.title", "notice.browser.takeover.body",
        "notice.connector.changed.title", "notice.connector.consent.title", "notice.connector.consent.body",
        "notice.connector.reconnect.title", "notice.connector.reconnect.body",
        "notice.mcp.changed.title", "notice.mcp.review.body", "notice.mcp.suspicious.title",
        "notice.security.changed.title", "notice.security.firstAdmin.title", "notice.security.firstSeal.title",
        "notice.security.tightened.body", "notice.security.untrusted.title", "notice.security.untrusted.body",
        "notice.apiKey.changed.title", "notice.apiKey.changed.body",
        "notice.approvals.digest.title",
        "notice.approvals.resumeMissed.title", "notice.approvals.resumeMissed.body",
        "notice.connector.changed.body",
        "notice.security.changed.body", "notice.security.firstAdmin.body", "notice.security.firstSeal.body",
        "notice.security.recovery.title", "notice.security.recovery.body",
        "notice.security.resealed.title", "notice.security.resealed.body",
        "notice.security.resealRequested.title",
        "notice.security.tightened.title",
        "notice.specialist.result.title", "notice.specialist.result.body",
        "notice.action.keepIt",
    ]

    static func title(_ item: InboxItem) -> String {
        text(item.message?.titleKey, item.message?.params ?? [:], fallback: item.title)
    }

    static func body(_ item: InboxItem) -> String {
        text(item.message?.bodyKey, item.message?.params ?? [:], fallback: item.body)
    }

    static func label(_ action: InboxAction) -> String {
        lookup(action.labelKey) ?? action.label
    }

    /// The catalog text for `key`, rendered with `params` in the phone's language. Falls back to `fallback` when the
    /// key is unknown or its markup does not parse, so a broken string never shows half-rendered markup.
    static func text(_ key: String?, _ params: [String: String], fallback: String) -> String {
        guard let template = lookup(key) else { return fallback }
        return render(template, params, language: language) ?? fallback
    }

    /// The catalog string for a key this build knows, or nil. `Bundle.module.localizedString` returns the value
    /// passed here when the key is missing, so an empty value means "not in the catalog".
    static func lookup(_ key: String?) -> String? {
        guard let key, knownKeys.contains(key) else { return nil }
        let value = Bundle.module.localizedString(forKey: key, value: "", table: nil)
        return value.isEmpty ? nil : value
    }

    /// The language the catalog is read in, as a bare code for the plural rules ("zh-Hans" is "zh").
    static var language: String {
        let tag = Bundle.module.preferredLocalizations.first ?? "en"
        return String(tag.prefix { $0 != "-" })
    }

    /// Fills `{name}` in one pass, so a value that itself contains braces is shown as written.
    static func fill(_ template: String, _ params: [String: String]) -> String {
        var out = ""
        var rest = template[...]
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            out += rest[..<open]
            let name = String(rest[rest.index(after: open)..<close])
            out += params[name] ?? String(rest[open...close])
            rest = rest[rest.index(after: close)...]
        }
        out += rest
        return out
    }

    // MARK: - ICU MessageFormat subset

    /// One part of a catalog string: literal text, `#` (the plural's number), `{name}`, or a `select`/`plural`.
    enum Piece: Equatable {
        case text(String)
        case hash
        case argument(String)
        case choice(Choice)
    }

    /// `{name, select, …}` or `{name, plural, …}`. `source` is the markup as written, shown when `name` has no value.
    struct Choice: Equatable {
        let name: String
        let isPlural: Bool
        let source: String
        let branches: [String: [Piece]]
    }

    /// Renders a catalog string. Supports `{name}`, `{name, select, key {…} other {…}}` and
    /// `{name, plural, =0 {…} one {…} other {…}}` with `#` for the number, nested. A missing param keeps its
    /// placeholder as written. A param value is inserted as is and never parsed. Returns nil when the markup does
    /// not parse.
    static func render(_ template: String, _ params: [String: String], language: String) -> String? {
        guard let pieces = parse(template) else { return nil }
        var out = ""
        draw(pieces, params, language: language, number: nil, into: &out)
        return out
    }

    /// The parsed pieces of a catalog string, or nil when the markup is malformed: an unclosed or stray brace, an
    /// unknown type, or a select/plural without an `other` branch.
    static func parse(_ template: String) -> [Piece]? {
        var parser = Parser(chars: Array(template))
        guard let pieces = parser.message(inPlural: false, inBranch: false), parser.i == parser.chars.count else {
            return nil
        }
        return pieces
    }

    /// The names of every `{name}`, `select` and `plural` in a catalog string, nested ones included. Nil when the
    /// markup does not parse.
    static func argumentNames(_ template: String) -> Set<String>? {
        guard let pieces = parse(template) else { return nil }
        var names = Set<String>()
        collectNames(pieces, into: &names)
        return names
    }

    private static func collectNames(_ pieces: [Piece], into names: inout Set<String>) {
        for piece in pieces {
            switch piece {
            case .text, .hash: continue
            case .argument(let name): names.insert(name)
            case .choice(let choice):
                names.insert(choice.name)
                for branch in choice.branches.values { collectNames(branch, into: &names) }
            }
        }
    }

    private static func draw(
        _ pieces: [Piece], _ params: [String: String], language: String, number: String?, into out: inout String
    ) {
        for piece in pieces {
            switch piece {
            case .text(let text):
                out += text
            case .hash:
                out += number ?? "#"
            case .argument(let name):
                out += params[name] ?? "{\(name)}"
            case .choice(let choice):
                guard let value = params[choice.name] else {
                    out += choice.source
                    continue
                }
                if choice.isPlural {
                    draw(pluralBranch(choice, value, language: language), params, language: language,
                         number: value, into: &out)
                } else {
                    draw(choice.branches[value] ?? choice.branches["other"] ?? [], params, language: language,
                         number: number, into: &out)
                }
            }
        }
    }

    /// The branch for a plural value: an exact `=N` match first, then its CLDR category, then `other`. A value that is
    /// not a whole number uses `other`.
    private static func pluralBranch(_ choice: Choice, _ value: String, language: String) -> [Piece] {
        guard let n = Int(value) else { return choice.branches["other"] ?? [] }
        if let exact = choice.branches["=\(n)"] { return exact }
        return choice.branches[pluralCategory(n, language: language)] ?? choice.branches["other"] ?? []
    }

    /// The CLDR cardinal plural category of a whole number. Matches `Intl.PluralRules` for 0 to 2000 in each
    /// catalog language (en, ar, de, es, fr, hi, it, ja, ko, pt, zh).
    static func pluralCategory(_ number: Int, language: String) -> String {
        let n = abs(number)
        switch language {
        case "ar":
            if n == 0 { return "zero" }
            if n == 1 { return "one" }
            if n == 2 { return "two" }
            let rest = n % 100
            if (3...10).contains(rest) { return "few" }
            if (11...99).contains(rest) { return "many" }
            return "other"
        case "fr", "hi", "pt":
            return n == 0 || n == 1 ? "one" : "other"
        case "ja", "ko", "zh":
            return "other"
        default:
            return n == 1 ? "one" : "other"
        }
    }

    /// Reads a catalog string one character at a time. `i` is the next character to read.
    private struct Parser {
        let chars: [Character]
        var i = 0

        private var peek: Character? { i < chars.count ? chars[i] : nil }

        /// Reads text and arguments until the end of input or, inside a branch, the `}` that closes it. `#` is the
        /// plural's number only inside a plural, and is plain text everywhere else.
        mutating func message(inPlural: Bool, inBranch: Bool) -> [Piece]? {
            var pieces: [Piece] = []
            var text = ""
            while let c = peek {
                if c == "}" {
                    guard inBranch else { return nil }
                    break
                }
                if c == "{" {
                    if !text.isEmpty { pieces.append(.text(text)); text = "" }
                    guard let piece = argument(inPlural: inPlural) else { return nil }
                    pieces.append(piece)
                } else if c == "#" && inPlural {
                    if !text.isEmpty { pieces.append(.text(text)); text = "" }
                    pieces.append(.hash)
                    i += 1
                } else {
                    text.append(c)
                    i += 1
                }
            }
            if !text.isEmpty { pieces.append(.text(text)) }
            return pieces
        }

        /// Reads `{name}` or `{name, select|plural, selector {message} … other {message}}`. `i` is at the `{`.
        private mutating func argument(inPlural: Bool) -> Piece? {
            let start = i
            i += 1
            skipSpace()
            guard let name = identifier() else { return nil }
            skipSpace()
            if peek == "}" {
                i += 1
                return .argument(name)
            }
            guard peek == "," else { return nil }
            i += 1
            skipSpace()
            guard let kind = identifier(), kind == "select" || kind == "plural" else { return nil }
            skipSpace()
            guard peek == "," else { return nil }
            i += 1
            let isPlural = kind == "plural"
            var branches: [String: [Piece]] = [:]
            while true {
                skipSpace()
                if peek == "}" {
                    i += 1
                    break
                }
                guard let selector = self.selector() else { return nil }
                skipSpace()
                guard peek == "{" else { return nil }
                i += 1
                guard let body = message(inPlural: isPlural || inPlural, inBranch: true), peek == "}" else {
                    return nil
                }
                i += 1
                branches[selector] = body
            }
            guard branches["other"] != nil else { return nil }
            let source = String(chars[start..<i])
            return .choice(Choice(name: name, isPlural: isPlural, source: source, branches: branches))
        }

        /// A branch selector: an identifier, or `=` and a number for an exact plural match.
        private mutating func selector() -> String? {
            let start = i
            if peek == "=" {
                i += 1
                let digitsStart = i
                while let c = peek, c.isASCII, c.isNumber { i += 1 }
                return i > digitsStart ? String(chars[start..<i]) : nil
            }
            return identifier()
        }

        private mutating func identifier() -> String? {
            let start = i
            while let c = peek, c.isASCII, c.isLetter || c.isNumber || c == "_" { i += 1 }
            return i > start ? String(chars[start..<i]) : nil
        }

        private mutating func skipSpace() {
            while let c = peek, c.isWhitespace { i += 1 }
        }
    }
}
