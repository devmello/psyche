import Testing

@testable import PsycheBlocks

struct MarkdownParserTests {
    @Test func headingsListsQuotesAndCode() {
        let blocks = MarkdownParser.parse(
            "# Title\n\nSome *text*\nacross two lines\n\n- one\n- two\n  continued\n\n1. first\n2. second\n\n> quoted\n\n```swift\nlet x = 1\n```\n\n---"
        )
        #expect(
            blocks == [
                .heading(level: 1, text: "Title"),
                .paragraph("Some *text*\nacross two lines"),
                .bullets(["one", "two continued"]),
                .numbered(start: 1, items: ["first", "second"]),
                .quote("quoted"),
                .code(language: "swift", text: "let x = 1", closed: true),
                .rule,
            ])
    }

    @Test func anUnclosedFenceStaysOpenWhileStreaming() {
        let blocks = MarkdownParser.parse("Here:\n\n```\nline one\nline t")
        #expect(blocks.last == .code(language: nil, text: "line one\nline t", closed: false))
    }

    @Test func hashWithoutSpaceIsNotAHeading() {
        #expect(MarkdownParser.parse("#nospace") == [.paragraph("#nospace")])
    }

    @Test func orderedListKeepsItsStartNumber() {
        #expect(MarkdownParser.parse("3. c\n4. d") == [.numbered(start: 3, items: ["c", "d"])])
    }

    @Test func inlineMarkdownRendersAndKeepsLineBreaks() {
        let rendered = MarkdownBlock.inline("a **b**\nc")
        #expect(String(rendered.characters) == "a b\nc")
    }

    @Test func emptyInputHasNoBlocks() {
        #expect(MarkdownParser.parse("").isEmpty)
        #expect(MarkdownParser.parse("\n\n").isEmpty)
    }
}
