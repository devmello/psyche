import Foundation
import PsycheProtocol

/// The Swift twin of `classifyPointsValue` (packages/protocol/src/points-rules.ts): a value that is a
/// secret whatever field it is in. A hit drops the value and marks the field `value_shape`. Tested
/// against `valueShapes` in `points-sensitive.json`.
public enum PointsValueRules {
    private static func re(_ p: String, _ o: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: p, options: o)  // swiftlint:disable:this force_try
    }

    private static let postalLabel = re(
        "(?:(?<![A-Za-z0-9_])(?:zip|postal|post|area|country|dial(?:l)?ing|plz)[- ]?(?:code)?(?![A-Za-z0-9_]))|\u{90F5}\u{4FBF}\u{756A}\u{53F7}|\u{90AE}\u{653F}\u{7F16}\u{7801}|\u{90AE}\u{7F16}|\u{C6B0}\u{D3B8}\u{BC88}\u{D638}|\u{92A}\u{93F}\u{928} \u{915}\u{94B}\u{921}|\u{627}\u{644}\u{631}\u{645}\u{632} \u{627}\u{644}\u{628}\u{631}\u{64A}\u{62F}\u{64A}",
        [.caseInsensitive])
    private static let ibanCandidate = re("(?<![A-Za-z0-9])[A-Za-z]{2}\\d{2}(?:[ ./_-]?[A-Za-z0-9]){11,30}")
    private static let separator = re("^[\\p{Pd}\\p{Zs}.,:/_\u{B7}\u{30FC}\u{2212}]{1,3}$")
    private static let dashOnly = re("^\\p{Pd}$")

    public static func classify(_ value: String, label: String = "") -> PointsSensitiveReason? {
        let v = shapeText(value).trimmingCharacters(in: .whitespacesAndNewlines)
        let l = postalLabel.stringByReplacingMatches(in: label, range: NSRange(label.startIndex..., in: label), withTemplate: " ")
        if let t = teachValue(v, l) ?? teachValue(value, l) { return t }
        let ns = v as NSString
        for m in ibanCandidate.matches(in: v, range: NSRange(location: 0, length: ns.length)) where isIban(ns.substring(with: m.range)) {
            return .payment
        }
        if let s = digitShapes(v).first { return s.reason }
        if v.range(of: "^\\d{4,8}$", options: .regularExpression) != nil, PointsSensitiveJudge.labelReason(l) == .oneTimeCode { return .oneTimeCode }
        return nil
    }

    /// `classifyTeachValue` of browser-teach.ts (the bare 4 to 8 digit rule needs a code word in the label).
    static func teachValue(_ value: String, _ label: String) -> PointsSensitiveReason? {
        func has(_ p: String, in s: String, _ o: String.CompareOptions = .regularExpression) -> Bool { s.range(of: p, options: o) != nil }
        let ns = value as NSString
        let cards = re("(?:\\d[ -]?){13,19}").matches(in: value, range: NSRange(location: 0, length: ns.length))
        for m in cards {
            let digits = ns.substring(with: m.range).filter(\.isNumber)
            if (13...19).contains(digits.count), AppTeachPolicy.luhn(digits) { return .payment }
        }
        if has("\\b\\d{3}-\\d{2}-\\d{4}\\b", in: value) { return .identity }
        let t = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if has("^[A-Za-z0-9_-]{32,}$", in: t) { return .secret }
        if has("\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.", in: value) { return .secret }
        if has("\\b(?:sk|pk|rk|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}", in: value) { return .secret }
        if has("[A-Za-z][A-Za-z0-9+.-]*://[^/\\s:@]+:[^/\\s@]+@", in: value) { return .secret }
        let words = t.split(whereSeparator: { $0.isWhitespace })
        if [12, 15, 18, 21, 24].contains(words.count),
           words.allSatisfy({ $0.count >= 3 && $0.count <= 8 && $0.allSatisfy { $0.isASCII && $0.isLowercase && $0.isLetter } }) { return .secret }
        if has("^\\d{4,8}$", in: t), has("\\b(?:code|pin|otp|token)\\b", in: label.lowercased()) { return .oneTimeCode }
        return nil
    }

    // MARK: Shapes

    static func shapeText(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for s in text.unicodeScalars where !(s.properties.isDefaultIgnorableCodePoint || s.properties.generalCategory == .format || s.value == 0x2800) {
            out.append(s)
        }
        var digits = ""
        for ch in String(out).precomposedStringWithCompatibilityMapping {
            if ch.unicodeScalars.allSatisfy({ $0.value >= 128 && $0.properties.generalCategory == .decimalNumber }), let n = ch.wholeNumberValue {
                digits += String(n)
            } else if !(ch.unicodeScalars.allSatisfy { $0.properties.isDefaultIgnorableCodePoint || $0.properties.generalCategory == .format }) {
                digits.append(ch)
            }
        }
        return digits
    }

    static func isIban(_ raw: String) -> Bool {
        let s = String(raw.filter { !" ./_-".contains($0) }).uppercased()
        guard s.range(of: "^[A-Z]{2}\\d{2}[A-Z0-9]{11,30}$", options: .regularExpression) != nil else { return false }
        let moved = String(s.dropFirst(4)) + String(s.prefix(4))
        var rem = 0
        for ch in moved.unicodeScalars {
            let digits = ch.value >= 65 ? String(ch.value - 55) : String(ch)
            for d in digits { rem = (rem * 10 + (d.wholeNumberValue ?? 0)) % 97 }
        }
        return rem == 1
    }

    struct Shape {
        var reason: PointsSensitiveReason
    }

    /// Card numbers (13 to 19 digits passing Luhn in any run of groups) and nine-digit runs with any grouping.
    static func digitShapes(_ text: String) -> [Shape] {
        let chars = Array(text)
        struct Group { var start: Int; var end: Int; var digits: String }
        var groups: [Group] = []
        var i = 0
        while i < chars.count {
            if chars[i].isASCII, chars[i].isNumber {
                var j = i
                while j < chars.count, chars[j].isASCII, chars[j].isNumber { j += 1 }
                groups.append(Group(start: i, end: j, digits: String(chars[i..<j])))
                i = j
            } else { i += 1 }
        }
        var chains: [[Group]] = []
        var chain: [Group] = []
        for g in groups {
            if let last = chain.last, matches(separator, String(chars[last.end..<g.start])) { chain.append(g) } else {
                if !chain.isEmpty { chains.append(chain) }
                chain = [g]
            }
        }
        if !chain.isEmpty { chains.append(chain) }
        var out: [Shape] = []
        for c in chains {
            guard let first = c.first else { continue }
            let total = c.reduce(0) { $0 + $1.digits.count }
            let zip4 = c.count == 2 && c[0].digits.count == 5 && c[1].digits.count == 4 && matches(dashOnly, String(chars[c[0].end..<c[1].start]))
            let plus = first.start > 0 && chars[first.start - 1] == "+"
            if total == 9, !zip4, !plus { out.append(Shape(reason: .identity)) }
            for a in 0..<c.count {
                var all = ""
                for b in a..<c.count {
                    all += c[b].digits
                    if all.count > 19 { break }
                    if all.count >= 13, AppTeachPolicy.luhn(all) { out.append(Shape(reason: .payment)) }
                }
            }
        }
        return out
    }

    private static func matches(_ r: NSRegularExpression, _ s: String) -> Bool {
        r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
}
