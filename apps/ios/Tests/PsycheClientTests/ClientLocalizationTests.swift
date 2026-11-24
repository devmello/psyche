import Foundation
import Testing

/// PsycheClient's user-visible strings go through its own catalog (`bundle: .module`). The test host is
/// English, so a non-English lookup can't be shown here. These checks read the sources and the catalog
/// instead: every `String(localized:…, bundle: .module)` must have a key in the catalog, and every key must
/// carry all eleven locales.
struct ClientLocalizationTests {
    static let locales = ["en", "ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh-Hans"]

    static let clientDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // PsycheClientTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // apps/ios
        .appendingPathComponent("Sources/PsycheClient")

    static func catalogStrings() throws -> [String: [String: Any]] {
        let url = clientDir.appendingPathComponent("Resources/Localizable.xcstrings")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        return json?["strings"] as? [String: [String: Any]] ?? [:]
    }

    /// A Swift literal as a regular expression over the catalog key: each interpolation is `%@` or `%lld`.
    static func catalogPattern(_ literal: String) -> String {
        let chars = Array(literal)
        var pattern = ""
        var staticPart = ""
        var i = 0
        while i < chars.count {
            if chars[i] == "\\", i + 1 < chars.count, chars[i + 1] == "(" {
                pattern += NSRegularExpression.escapedPattern(for: staticPart) + "(?:%@|%lld)"
                staticPart = ""
                var depth = 0
                i += 1
                while i < chars.count {
                    if chars[i] == "(" { depth += 1 }
                    if chars[i] == ")" {
                        depth -= 1
                        if depth == 0 { break }
                    }
                    i += 1
                }
            } else {
                staticPart.append(chars[i])
            }
            i += 1
        }
        return pattern + NSRegularExpression.escapedPattern(for: staticPart)
    }

    @Test func everyKeyHasEveryLocale() throws {
        let strings = try Self.catalogStrings()
        #expect(!strings.isEmpty)
        for (key, entry) in strings {
            let localizations = entry["localizations"] as? [String: Any] ?? [:]
            let missing = Self.locales.filter { localizations[$0] == nil }
            #expect(missing.isEmpty, "\(key) has no translation for \(missing)")
        }
    }

    @Test func everyLocalizedLiteralHasACatalogKey() throws {
        let keys = Array(try Self.catalogStrings().keys)
        let call = try NSRegularExpression(
            pattern: #"String\(localized:\s*"((?:[^"\\\n]|\\.)*)",\s*bundle:\s*\.module\)"#)
        let files = (FileManager.default.enumerator(at: Self.clientDir, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL } ?? []).filter { $0.pathExtension == "swift" }
        var checked = 0
        for file in files {
            let source = try String(contentsOf: file, encoding: .utf8)
            for match in call.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
                guard let range = Range(match.range(at: 1), in: source) else { continue }
                let literal = String(source[range])
                checked += 1
                let pattern = try NSRegularExpression(pattern: "^" + Self.catalogPattern(literal) + "$")
                let found = keys.contains { key in
                    pattern.firstMatch(in: key, range: NSRange(key.startIndex..., in: key)) != nil
                }
                #expect(found, "\(file.lastPathComponent): \"\(literal)\" has no key in Localizable.xcstrings")
            }
        }
        #expect(checked >= 100, "expected the localized literals to be scanned, found \(checked)")
    }
}
