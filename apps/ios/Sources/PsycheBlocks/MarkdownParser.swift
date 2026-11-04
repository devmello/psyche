import Foundation

/// A block of chat Markdown. Inline syntax (bold, italics, code, links) stays in the strings and is
/// rendered by `AttributedString(markdown:)`; this parser only finds the block structure
/// (docs/design/ios-app-2026.md §5).
public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullets([String])
    case numbered(start: Int, items: [String])
    case quote(String)
    /// A fenced code block. `closed` is false while the closing fence hasn't streamed in yet.
    case code(language: String?, text: String, closed: Bool)
    case rule
}

public enum MarkdownParser {
    public static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var index = 0

        func flush(_ paragraph: inout [String]) {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph.removeAll()
        }

        var paragraph: [String] = []
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                flush(&paragraph)
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                var closed = false
                index += 1
                while index < lines.count {
                    if lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                        closed = true
                        break
                    }
                    body.append(lines[index])
                    index += 1
                }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n"), closed: closed))
                index += 1
                continue
            }

            if trimmed.isEmpty {
                flush(&paragraph)
                index += 1
                continue
            }

            if let heading = headingParts(trimmed) {
                flush(&paragraph)
                blocks.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            if isRule(trimmed) {
                flush(&paragraph)
                blocks.append(.rule)
                index += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flush(&paragraph)
                var quoted: [String] = []
                while index < lines.count {
                    let t = lines[index].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    quoted.append(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                blocks.append(.quote(quoted.joined(separator: "\n")))
                continue
            }

            if bulletText(trimmed) != nil {
                flush(&paragraph)
                var items: [String] = []
                while index < lines.count {
                    let t = lines[index].trimmingCharacters(in: .whitespaces)
                    if let text = bulletText(t) {
                        items.append(text)
                    } else if !t.isEmpty, !items.isEmpty, orderedParts(t) == nil, headingParts(t) == nil,
                        lines[index].hasPrefix(" ")
                    {
                        // An indented continuation line belongs to the previous item.
                        items[items.count - 1] += " " + t
                    } else {
                        break
                    }
                    index += 1
                }
                blocks.append(.bullets(items))
                continue
            }

            if let first = orderedParts(trimmed) {
                flush(&paragraph)
                var items: [String] = []
                while index < lines.count {
                    let t = lines[index].trimmingCharacters(in: .whitespaces)
                    if let part = orderedParts(t) {
                        items.append(part.text)
                    } else if !t.isEmpty, !items.isEmpty, bulletText(t) == nil, headingParts(t) == nil,
                        lines[index].hasPrefix(" ")
                    {
                        items[items.count - 1] += " " + t
                    } else {
                        break
                    }
                    index += 1
                }
                blocks.append(.numbered(start: first.number, items: items))
                continue
            }

            paragraph.append(trimmed)
            index += 1
        }
        flush(&paragraph)
        return blocks
    }

    private static func headingParts(_ line: String) -> (level: Int, text: String)? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.count > hashes else { return nil }
        let rest = line.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        return (hashes, rest.trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ line: String) -> Bool {
        let chars = line.filter { !$0.isWhitespace }
        guard chars.count >= 3, let first = chars.first, "-*_".contains(first) else { return false }
        return chars.allSatisfy { $0 == first }
    }

    private static func bulletText(_ line: String) -> String? {
        guard let first = line.first, "-*+•".contains(first) else { return nil }
        let rest = line.dropFirst()
        guard rest.first == " " else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : text
    }

    private static func orderedParts(_ line: String) -> (number: Int, text: String)? {
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 4, let number = Int(digits) else { return nil }
        let rest = line.dropFirst(digits.count)
        guard let marker = rest.first, marker == "." || marker == ")" else { return nil }
        let afterMarker = rest.dropFirst()
        guard afterMarker.first == " " else { return nil }
        return (number, afterMarker.trimmingCharacters(in: .whitespaces))
    }
}

extension MarkdownBlock {
    /// Inline Markdown to `AttributedString`, keeping line breaks; falls back to plain text.
    public static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        return LinkPolicy.sanitized(parsed)
    }
}
