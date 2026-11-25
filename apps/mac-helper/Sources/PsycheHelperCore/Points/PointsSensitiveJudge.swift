import Foundation
import PsycheProtocol

/// What the helper knows about one field, from the element alone (docs/design/psyche-points-2026.md
/// §5.1). Every text is the page's own and untrusted. Nothing here is a field's value.
public struct PointsFieldFacts: Sendable, Equatable {
    public var label: String?
    public var placeholder: String?
    public var help: String?
    public var identifier: String?
    public var autocomplete: String?
    /// `AXSecureTextField`, or Secure Event Input is on and this field has the focus.
    public var secure: Bool
    /// Group, sheet and heading titles above the field, outermost first.
    public var path: [String]
    /// The few static texts just before the field, and its linked labels.
    public var nearbyText: [String]

    public init(
        label: String? = nil, placeholder: String? = nil, help: String? = nil, identifier: String? = nil, autocomplete: String? = nil,
        secure: Bool = false, path: [String] = [], nearbyText: [String] = []
    ) {
        self.label = label
        self.placeholder = placeholder
        self.help = help
        self.identifier = identifier
        self.autocomplete = autocomplete
        self.secure = secure
        self.path = path
        self.nearbyText = nearbyText
    }
}

/// What the page tells us (§2.2).
public struct PointsPageFacts: Sendable, Equatable {
    public var url: String?
    public var host: String?
    public var title: String?
    public var hasPaymentFields: Bool
    public var insecure: Bool

    public init(url: String? = nil, host: String? = nil, title: String? = nil, hasPaymentFields: Bool = false, insecure: Bool = false) {
        self.url = url
        self.host = host
        self.title = title
        self.hasPaymentFields = hasPaymentFields
        self.insecure = insecure
    }
}

/// The sensitive-field judge of Psyche points: the Swift twin of `classifyPointsField` and
/// `classifyPointsPage` in `packages/protocol/src/points-rules.ts`. It reuses `AppTeachPolicy`'s
/// words (teach by showing is unchanged) and adds the Points words, the card tokens of
/// `isPaymentField` and the near-miss phrases, all tested against the shared probe table
/// (`PointsJudgeFixtureTests`). A false match fails safe: the field only gets "You fill this yourself".
/// A false miss would read a secret, so this runs before any value is read.
public enum PointsSensitiveJudge {
    typealias Reason = PointsSensitiveReason

    // MARK: Page

    /// Whether Points gives directions only on this page (§2.2): a payment or bank page, a venue
    /// host, or plain `http:`. Every field on such a page counts as sensitive.
    public static func isDirectionsOnly(_ page: PointsPageFacts) -> Bool {
        if page.insecure { return true }
        if let url = page.url, url.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("http://") { return true }
        if isMoneyContext(page) { return true }
        return venueOfHost(page.host ?? page.url)
    }

    static let contextPath = try! NSRegularExpression(
        pattern: "/(checkout|payments?|pay|purchase|billing|transfers?|withdraw(al)?|send-money|wallet|banking)(/|$)", options: [.caseInsensitive])
    static let contextTitle = try! NSRegularExpression(
        pattern: "\\b(checkout|check out|payment|billing|order summary|review (your |my )?order|pay(ing)? (now|for)|confirm (your )?(payment|order|purchase|transfer)|send money|transfer funds|wallet|banking|online banking|withdraw(al)?|send crypto)\\b",
        options: [.caseInsensitive])

    static func isMoneyContext(_ page: PointsPageFacts) -> Bool {
        if page.hasPaymentFields { return true }
        if let url = page.url {
            let path = URLComponents(string: url)?.path ?? url
            if matches(contextPath, path) { return true }
        }
        if let title = page.title, matches(contextTitle, title) { return true }
        return false
    }

    static func financialHost(_ input: String?) -> String? {
        guard let input else { return nil }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        let hasScheme = text.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) != nil
        guard let host = URLComponents(string: hasScheme ? text : "https://" + text)?.host?.lowercased() else { return nil }
        var h = host
        while h.hasSuffix(".") { h.removeLast() }
        return h.isEmpty ? nil : h
    }

    static func venueOfHost(_ input: String?) -> Bool {
        guard let host = financialHost(input) else { return false }
        return PointsRuleTables.venueDomains.contains { host == $0 || host.hasSuffix("." + $0) }
    }

    // MARK: Field

    /// The reason a field is sensitive, or nil. `directionsOnly` is `isDirectionsOnly(page)`.
    public static func classify(_ f: PointsFieldFacts, directionsOnly: Bool = false) -> PointsSensitiveReason? {
        if f.secure { return .secureField }
        if directionsOnly { return .directionsOnly }
        let own = [f.label, f.placeholder, f.help].compactMap { $0 }
        for t in own {
            if let r = reasonOfText(t) ?? reasonOfText(identifierWords(t)) { return r }
        }
        if let r = reasonOfParts(own) ?? reasonOfParts([f.label, f.placeholder].compactMap { $0 }) ?? reasonOfParts([f.label, f.help].compactMap { $0 }) { return r }
        if let id = f.identifier, let r = reasonOfText(identifierWords(id)) ?? reasonOfText(id) { return r }
        let texts = own.flatMap(variantsOf)
        if isPaymentField(autocomplete: f.autocomplete, name: f.identifier, label: nil) { return .payment }
        for t in texts where isPaymentField(autocomplete: nil, name: nil, label: t) { return .payment }
        if let a = f.autocomplete {
            for token in a.lowercased().split(whereSeparator: { $0.isWhitespace }) {
                if token.hasPrefix("cc-") { return .payment }
                if token == "current-password" || token == "new-password" { return .password }
                if token == "one-time-code" { return .oneTimeCode }
            }
        }
        for ctx in f.path + f.nearbyText {
            if let r = reasonOfText(ctx) { return r }
        }
        return nil
    }

    // MARK: Words

    private static func compile(_ source: String) -> NSRegularExpression {
        // JavaScript's `\b` is ASCII; ICU's is Unicode. The sources were written for JavaScript.
        let ascii = "(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))"
        let fixed = source.replacingOccurrences(of: "\\b", with: ascii)
        return try! NSRegularExpression(pattern: fixed, options: [.caseInsensitive])  // swiftlint:disable:this force_try
    }

    private static let pointsWords: [(PointsSensitiveReason, NSRegularExpression)] = PointsRuleTables.words.map { (reasonOf($0.reason), compile($0.source)) }
    private static let benign: [NSRegularExpression] = PointsRuleTables.benign.map { compile($0) }
    private static let passportFile = compile(
        "passport[- ]?(?:photo|picture|image|scan|upload|copy|file|attachment)s?|(?:upload|attach|scan)(?:ned|ed)?[- ]+(?:(?:your|a|an|the|of|my|copy|copies)[- ]+){0,3}passport")
    private static let passportKeep = compile("\\b(?:number|no|num|nr|id|numero|nummer)\\b|#|photo[- ]?page|data[- ]?page|bio(?:graphic)?[- ]?page|\\bpage\\b")
    private static let einCased = try! NSRegularExpression(pattern: "(?<![\\p{L}\\p{N}])EIN(?![\\p{L}\\p{N}])")

    private static func reasonOf(_ s: String) -> PointsSensitiveReason {
        switch s {
        case "password": return .password
        case "one_time_code": return .oneTimeCode
        case "payment": return .payment
        case "identity": return .identity
        default: return .secret
        }
    }

    private static func reasonOf(_ r: AppTeachSensitive) -> PointsSensitiveReason {
        switch r {
        case .password: return .password
        case .oneTimeCode: return .oneTimeCode
        case .payment: return .payment
        case .identity: return .identity
        case .secret: return .secret
        }
    }

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, options: [], range: NSRange(s.startIndex..., in: s)) != nil
    }

    private static func replacing(_ re: NSRegularExpression, in s: String, with t: String) -> String {
        re.stringByReplacingMatches(in: s, options: [], range: NSRange(s.startIndex..., in: s), withTemplate: t)
    }

    private static func testWords(_ text: String) -> PointsSensitiveReason? {
        // The shared teach words first (`classifyTeachField({label})`), then the Points words.
        let range = NSRange(text.startIndex..., in: text)
        for (reason, re) in AppTeachPolicy.words where re.firstMatch(in: text, options: [], range: range) != nil { return reasonOf(reason) }
        for (reason, re) in pointsWords where re.firstMatch(in: text, options: [], range: range) != nil { return reason }
        return nil
    }

    private static func neutralise(_ text: String) -> String {
        var out = text
        for re in benign { out = replacing(re, in: out, with: " ") }
        if !matches(passportKeep, out) { out = replacing(passportFile, in: out, with: " ") }
        return out
    }

    // MARK: Folding

    private static let apostrophes: Set<Unicode.Scalar> = ["\u{2019}", "\u{2018}", "\u{02BC}", "\u{00B4}", "`", "\u{2032}", "\u{2035}", "\u{02B9}", "\u{FF07}"]

    private static func isInvisible(_ s: Unicode.Scalar) -> Bool {
        s.properties.isDefaultIgnorableCodePoint || s.properties.generalCategory == .format || s.value == 0x2800
    }

    private static func stripInvisible(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for s in text.unicodeScalars where !isInvisible(s) { out.append(s) }
        return String(out)
    }

    private static func foldApostrophes(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for s in text.unicodeScalars { out.append(apostrophes.contains(s) ? "'" : s) }
        return String(out)
    }

    /// NFKC, lower case, single spaces: how every rule here reads text (`foldPointsText`).
    static func fold(_ text: String) -> String {
        let a = foldApostrophes(stripInvisible(text)).precomposedStringWithCompatibilityMapping
        return stripInvisible(a).lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func stripAccents(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for s in text.decomposedStringWithCanonicalMapping.unicodeScalars {
            switch s.properties.generalCategory {
            case .nonspacingMark, .spacingMark, .enclosingMark: continue
            default: out.append(s)
            }
        }
        return String(out).precomposedStringWithCanonicalMapping
    }

    private static func skeleton(_ text: String) -> String {
        var out = ""
        for ch in text { out += PointsRuleTables.confusables[String(ch)] ?? String(ch) }
        return out
    }

    private static func isAlnum(_ s: Unicode.Scalar) -> Bool {
        switch s.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }

    private static func isLetter(_ s: Unicode.Scalar) -> Bool {
        switch s.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: return true
        default: return false
        }
    }

    private static func isShortLetters(_ t: String) -> Bool {
        let n = t.unicodeScalars.count
        return (1...2).contains(n) && t.unicodeScalars.allSatisfy(isLetter)
    }

    /// `text.split(/([^\p{L}\p{N}]+)/u)`: tokens and separators alternating, a token first.
    private static func splitKeepingSeparators(_ text: String) -> [String] {
        var parts: [String] = []
        var cur = String.UnicodeScalarView()
        var inSep = false
        for s in text.unicodeScalars {
            if !inSep {
                if isAlnum(s) { cur.append(s) } else { parts.append(String(cur)); cur = String.UnicodeScalarView(); cur.append(s); inSep = true }
            } else {
                if !isAlnum(s) { cur.append(s) } else { parts.append(String(cur)); cur = String.UnicodeScalarView(); cur.append(s); inSep = false }
            }
        }
        parts.append(String(cur))
        if inSep { parts.append("") }
        return parts
    }

    /// `S S N`, `S.S.N.`, `S/S/N`, `IB AN`: runs of tokens of at most two letters, joined.
    static func joinShortRuns(_ text: String) -> String {
        let parts = splitKeepingSeparators(text)
        var out: [String] = []
        var i = 0
        while i < parts.count {
            let tok = parts[i]
            if isShortLetters(tok) {
                var j = i
                var joined = ""
                var n = 0
                while j < parts.count, isShortLetters(parts[j]) {
                    joined += parts[j]
                    n += 1
                    if j + 2 < parts.count, parts[j + 1].unicodeScalars.allSatisfy({ !isAlnum($0) }), !parts[j + 1].isEmpty, isShortLetters(parts[j + 2]) {
                        j += 2
                    } else { break }
                }
                if n >= 2 {
                    out.append(joined)
                    i = j + 1
                    continue
                }
            }
            out.append(tok)
            i += 1
        }
        return out.joined()
    }

    /// The four readings of a text: folded, accent-free, skeleton, short runs joined.
    static func readings(_ raw: String) -> [String] {
        let folded = fold(raw)
        let plain = stripAccents(folded)
        let skel = skeleton(plain)
        return [folded, plain, skel, joinShortRuns(skel)]
    }

    static func variantsOf(_ raw: String) -> [String] {
        var seen = Set<String>()
        return readings(raw).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    private static func identifierWords(_ id: String) -> String {
        var s = id
        s = s.replacingOccurrences(of: "([\\p{Ll}\\p{N}])(\\p{Lu})", with: "$1 $2", options: .regularExpression)
        s = s.replacingOccurrences(of: "(\\p{Lu})(\\p{Lu}\\p{Ll})", with: "$1 $2", options: .regularExpression)
        return s.replacingOccurrences(of: "[_\\-.\\[\\]:]+", with: " ", options: .regularExpression)
    }

    private static func reasonOfText(_ raw: String?) -> PointsSensitiveReason? {
        guard let raw, !raw.isEmpty else { return nil }
        if matches(einCased, foldApostrophes(stripInvisible(raw))) { return .identity }
        for v in variantsOf(raw) {
            if let r = testWords(neutralise(v)) { return r }
        }
        return nil
    }

    private static func reasonOfParts(_ parts: [String]) -> PointsSensitiveReason? {
        let all = parts.filter { !$0.isEmpty }.map(readings)
        if all.count < 2 { return nil }
        for k in 0..<4 {
            let joined = all.map { neutralise($0[k]) }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.joined(separator: " ")
            if let r = testWords(joined) { return r }
        }
        return nil
    }

    // MARK: The payment rule's card tokens (`isPaymentField` in money-intent.ts)

    private static let cardTokens: [NSRegularExpression] = [
        "\\bcc ?(num|number|no)\\b", "\\bcard ?(num|number|no)\\b", "\\bcardnumber\\b", "\\bccnumber\\b", "\\bcredit ?card\\b",
        "\\bdebit ?card\\b", "\\bcvv\\b", "\\bcvc\\b", "\\bcsc\\b", "\\bsecurity code\\b", "\\bcard ?(exp|expiry|expiration)\\b",
        "\\bcc ?(exp|expiry|expiration)\\b",
    ].map { try! NSRegularExpression(pattern: $0) }  // swiftlint:disable:this force_try
    private static let notPaymentCard: Set<String> = ["library", "loyalty", "membership", "student", "id", "sim"]
    private static let autocompleteCard = try! NSRegularExpression(pattern: "^cc-(number|exp|exp-month|exp-year|csc)$")

    static func moneyWords(_ text: String) -> [String] {
        let spaced = text.replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression).lowercased()
        let flat = spaced.replacingOccurrences(of: "[^\\p{L}\\p{N}]+", with: " ", options: .regularExpression)
        return flat.split(separator: " ").map(String.init)
    }

    static func isPaymentField(autocomplete: String?, name: String?, label: String?) -> Bool {
        let auto = (autocomplete ?? "").lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if auto.contains(where: { matches(autocompleteCard, $0) }) { return true }
        for text in [name, label] {
            guard let text, !text.isEmpty else { continue }
            let words = moneyWords(text)
            if words.contains(where: { notPaymentCard.contains($0) }) { continue }
            let joined = words.joined(separator: " ")
            if cardTokens.contains(where: { matches($0, joined) }) { return true }
        }
        return false
    }
}
