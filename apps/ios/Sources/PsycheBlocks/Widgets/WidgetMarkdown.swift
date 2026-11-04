import PsycheDesign
import PsycheStore
import SwiftUI

/// Markdown for the `markdown` node: a small block parser (headings, lists, quotes, fences,
/// paragraphs) with inline styling through `AttributedString`. No HTML, no images; links survive
/// only when they are http, https or mailto.
struct WidgetMarkdown: View {
    let source: String

    enum Block: Equatable {
        case heading(level: Int, text: String)
        case paragraph(String)
        case bullet(String)
        case numbered(Int, String)
        case quote(String)
        case code(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.parse(source).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func view(for block: Block) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(Self.inline(text))
                .font(level == 1 ? .headline : .subheadline.weight(.semibold))
                .foregroundStyle(PsycheColor.text)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(Self.inline(text)).font(.subheadline).foregroundStyle(PsycheColor.text)
                .fixedSize(horizontal: false, vertical: true)
        case .bullet(let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("•").foregroundStyle(PsycheColor.muted).accessibilityHidden(true)
                Text(Self.inline(text)).font(.subheadline).foregroundStyle(PsycheColor.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .numbered(let number, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(number).").monospacedDigit().foregroundStyle(PsycheColor.muted).font(.subheadline)
                Text(Self.inline(text)).font(.subheadline).foregroundStyle(PsycheColor.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .quote(let text):
            HStack(spacing: 10) {
                Rectangle().fill(PsycheColor.rule).frame(width: 2)
                Text(Self.inline(text)).font(.subheadline).foregroundStyle(PsycheColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .code(let code):
            CodeNodeView(code: CodeNode(code: code, language: nil))
        }
    }

    // MARK: Parsing

    static func parse(_ source: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var fence: [String]?

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: " "))) }
            paragraph = []
        }

        for raw in source.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let open = fence {
                    blocks.append(.code(open.joined(separator: "\n")))
                    fence = nil
                } else {
                    flush()
                    fence = []
                }
                continue
            }
            if fence != nil { fence?.append(raw); continue }
            if line.isEmpty { flush(); continue }
            if let heading = line.firstMatch(of: /^(#{1,6})\s+(.*)$/) {
                flush()
                blocks.append(.heading(level: heading.1.count, text: String(heading.2)))
            } else if let bullet = line.firstMatch(of: /^[-*+]\s+(.*)$/) {
                flush()
                blocks.append(.bullet(String(bullet.1)))
            } else if let numbered = line.firstMatch(of: /^(\d{1,3})[.)]\s+(.*)$/) {
                flush()
                blocks.append(.numbered(Int(numbered.1) ?? 1, String(numbered.2)))
            } else if let quote = line.firstMatch(of: /^>\s?(.*)$/) {
                flush()
                blocks.append(.quote(String(quote.1)))
            } else {
                paragraph.append(line)
            }
        }
        if let open = fence { blocks.append(.code(open.joined(separator: "\n"))) }
        flush()
        return blocks
    }

    /// Inline markdown to an `AttributedString`, with unsafe link schemes removed.
    static func inline(_ text: String) -> AttributedString {
        var result =
            (try? AttributedString(
                markdown: text,
                options: .init(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
        for run in result.runs {
            guard let link = run.link else { continue }
            if WidgetLink.safeURL(link.absoluteString) == nil {
                result[run.range].link = nil
            } else {
                result[run.range].foregroundColor = PsycheColor.inkText
            }
        }
        return result
    }
}
