import Foundation
import Testing

/// Every SwiftUI literal that the user reads must look up its module's string catalog. A bare
/// `Text("…")` resolves against `Bundle.main`, which has no catalog, so it shows in English in every
/// language. This scans the sources for the constructs that take a title or a label and fails on a
/// literal that has no `bundle: .module` after it. Wrapped forms (`String(localized:bundle:)`) are not
/// bare literals, so they are not matched.
struct LocalizedLiteralsTests {
    /// Shapes whose literal is shown to the user. Each pattern ends with the opening quote of the literal.
    /// The first group is SwiftUI views and modifiers. The second is this app's helpers that take a
    /// title, a label or a note as their first argument. The last ones take it as a named argument,
    /// as the first element of an array, or after a `done:` flag.
    static let patterns: [NSRegularExpression] = [
        #"\b(Text|Label|Button|SectionHeader|navigationTitle|alert|confirmationDialog|TextField|Picker|Link|accessibilityLabel|accessibilityHint|infoRow|toggleRow|section|actionRow|sectionHeader|emptyNote|quiet|note|message|tabLabel|PageHeader|StatusDot|EditOnMacNote|ArmingInkButton|GlassTextButton|PaperSearchField|todos|rows)\(\s*""#,
        #"\b(title|prompt|footer):\s*""#,
        #"\bEvidenceLine\(\s*\[\s*""#,
        #"\bstep\(done:\s*\w+,\s*""#,
    ].map { try! NSRegularExpression(pattern: $0) }

    /// Literals that are shown as is: the product name, and text with no letters (a digit, a bullet).
    static let allowed: Set<String> = ["Psyche"]

    /// The text of a Swift string literal starting at `start` (the index after the opening quote), with
    /// its interpolations left out. Returns the literal and the index just past its closing quote.
    static func literal(in line: String, from start: String.Index) -> (text: String, end: String.Index)? {
        var index = start
        var text = ""
        var depth = 0
        while index < line.endIndex {
            let char = line[index]
            if depth == 0, char == "\"" {
                return (text, line.index(after: index))
            }
            if char == "\\" {
                let next = line.index(after: index)
                guard next < line.endIndex else { return nil }
                if line[next] == "(" {
                    depth += 1
                    index = line.index(after: next)
                    continue
                }
                if depth == 0 { text.append(line[next]) }
                index = line.index(after: next)
                continue
            }
            if depth > 0 {
                if char == "(" { depth += 1 }
                if char == ")" { depth -= 1 }
            } else {
                text.append(char)
            }
            index = line.index(after: index)
        }
        return nil
    }

    /// Sources under `apps/ios/Sources`, found from this file's path (apps/ios/Tests/PsycheFeaturesTests/<file>).
    static func sourceFiles() -> [URL] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return [] }
        return walker.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    /// Bare literals in the constructs above that lack `bundle: .module` on the same line.
    static func unlocalizedLiterals() -> [String] {
        var found: [String] = []
        for file in sourceFiles() {
            guard let source = try? String(contentsOf: file, encoding: .utf8) else { continue }
            for (number, line) in source.components(separatedBy: "\n").enumerated() {
                let range = NSRange(line.startIndex..., in: line)
                // Fixtures, backends and previews hold sample data, not the strings the user reads.
                if file.lastPathComponent.hasPrefix("Fixture") || file.lastPathComponent.contains("Backend") || line.contains("#Preview") { continue }
                let inFeatures = file.path.contains("/PsycheFeatures/")
                for (index, pattern) in patterns.enumerated() where index == 0 || inFeatures {
                  for match in pattern.matches(in: line, range: range) {
                    guard let matchRange = Range(match.range, in: line) else { continue }
                    // The opening quote is the last character of the match.
                    let start = line.index(after: line.index(before: matchRange.upperBound))
                    guard let lit = literal(in: line, from: start) else { continue }
                    let rest = line[lit.end...]
                    if rest.contains("bundle: .module") { continue }
                    // Placeholders are redacted skeleton text, never shown.
                    if lit.text.hasPrefix("Placeholder") { continue }
                    if !lit.text.contains(where: \.isLetter) || allowed.contains(lit.text) { continue }
                    found.append("\(file.lastPathComponent):\(number + 1): \"\(lit.text)\"")
                  }
                }
            }
        }
        return found
    }

    @Test func userFacingLiteralsAreLocalizedWithTheirModuleBundle() {
        // Guard against an empty walk making the scan pass for the wrong reason.
        #expect(Self.sourceFiles().count > 100)
        let bare = Self.unlocalizedLiterals()
        #expect(bare.isEmpty, "Use `bundle: .module` or String(localized:bundle:) for: \(bare.joined(separator: ", "))")
    }

    /// PsycheShared has its own catalog (`Resources/Localizable.xcstrings`), so its user-facing strings (the Live
    /// Activity's status words, the endpoint's transport label, the share note) must name that bundle: a bare
    /// `String(localized:)` would look in the app's main bundle and show English everywhere.
    @Test func sharedStringsAreLocalizedWithTheSharedBundle() {
        let shared = Self.sourceFiles().filter { $0.path.contains("/PsycheShared/") }
        #expect(shared.count > 3)
        var bare: [String] = []
        for file in shared {
            guard let source = try? String(contentsOf: file, encoding: .utf8) else { continue }
            for (number, line) in source.components(separatedBy: "\n").enumerated()
            where line.contains("String(localized:") && !line.contains("bundle: .module") {
                bare.append("\(file.lastPathComponent):\(number + 1)")
            }
        }
        #expect(bare.isEmpty, "Add `bundle: .module` to: \(bare.joined(separator: ", "))")
    }

    @Test func theScannerFindsABareLiteral() {
        let line = #"Text("Save changes").font(.body)"#
        let range = NSRange(line.startIndex..., in: line)
        let match = Self.patterns[0].firstMatch(in: line, range: range)
        #expect(match != nil)
        let matchRange = Range(match!.range, in: line)!
        let start = line.index(after: line.index(before: matchRange.upperBound))
        guard let found = Self.literal(in: line, from: start) else {
            Issue.record("no literal found")
            return
        }
        #expect(found.text == "Save changes")
        #expect(!line[found.end...].contains("bundle: .module"))
    }
}
