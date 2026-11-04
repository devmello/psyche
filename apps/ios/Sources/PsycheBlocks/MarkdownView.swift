import PsycheDesign
import SwiftUI

/// Chat Markdown: inline styles via `AttributedString`, block structure from `MarkdownParser`.
/// While `streaming`, the last text element carries a caret and fades in by line.
public struct MarkdownView: View {
    private let blocks: [MarkdownBlock]
    private let streaming: Bool

    public init(_ text: String, streaming: Bool = false) {
        blocks = MarkdownParser.parse(text)
        self.streaming = streaming
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                blockView(block, isLast: streaming && index == blocks.count - 1)
            }
            if streaming, blocks.isEmpty || !lastHoldsCaret {
                Text(streamingCaret).font(.callout).foregroundStyle(PsycheColor.text)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tint(PsycheColor.inkText)
        .confirmsExternalLinks()
        .accessibilityElement(children: .contain)
    }

    private var lastHoldsCaret: Bool {
        switch blocks.last {
        case .paragraph, .heading, .bullets, .numbered, .quote: true
        default: false
        }
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock, isLast: Bool) -> some View {
        switch block {
        case .paragraph(let text):
            inlineText(text, isLast: isLast)
                .font(.callout).lineSpacing(3)
        case .heading(let level, let text):
            inlineText(text, isLast: isLast)
                .font(level == 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
        case .bullets(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    ListRow(marker: "\u{2022}", markerWidth: 14) {
                        inlineText(item, isLast: isLast && index == items.count - 1)
                    }
                }
            }
            .font(.callout).lineSpacing(3)
        case .numbered(let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    ListRow(marker: "\(start + index).", markerWidth: 24) {
                        inlineText(item, isLast: isLast && index == items.count - 1)
                    }
                }
            }
            .font(.callout).lineSpacing(3)
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                Capsule().fill(PsycheColor.rule).frame(width: 3)
                inlineText(text, isLast: isLast)
                    .font(.callout).lineSpacing(3)
                    .foregroundStyle(PsycheColor.muted)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text, _):
            CodeBlock(language: language, text: text)
        case .rule:
            HairlineDivider().padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func inlineText(_ text: String, isLast: Bool) -> some View {
        if isLast {
            StreamingText(text: MarkdownBlock.inline(text) + AttributedString(streamingCaret))
                .foregroundStyle(PsycheColor.text)
        } else {
            Text(MarkdownBlock.inline(text))
                .foregroundStyle(PsycheColor.text)
                .textSelection(.enabled)
        }
    }
}

private struct ListRow<Content: View>: View {
    let marker: String
    let markerWidth: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(marker).foregroundStyle(PsycheColor.muted).frame(width: markerWidth, alignment: .trailing)
            content
        }
    }
}

/// A fenced code block: mono, scrolls sideways instead of wrapping.
struct CodeBlock: View {
    let language: String?
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let language {
                Text(language).font(.psycheMono(.caption2)).foregroundStyle(PsycheColor.muted)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.psycheMono(.footnote))
                    .foregroundStyle(PsycheColor.text)
                    .fixedSize(horizontal: true, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PsycheColor.fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

#Preview("Markdown") {
    MarkdownView(
        "# Before you renew\n\nFour things are worth a question:\n\n- **Rent:** the letter says 4.5%\n- *Pets:* a $40 fee\n\n1. First\n2. Second\n\n> The cap in section 6 is the strongest point.\n\n```\nHi Sam, section 6 caps increases at 3%. Could you confirm the 4.5% in the letter?\n```\n\nA [link](https://example.com)."
    )
    .padding().psycheScreen()
}
