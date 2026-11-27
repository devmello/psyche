import Testing

@testable import PsycheBlocks

struct MarkdownBlockCacheTests {
    @Test func aFinishedMessageIsParsedOnceHoweverOftenItIsDrawn() {
        let cache = MarkdownBlockCache()
        let text = "# Cache test \(UInt64.random(in: 0...UInt64.max))\n\n- one\n- two"
        let before = cache.parseCount
        let first = cache.blocks(for: text)
        for _ in 0..<50 { #expect(cache.blocks(for: text) == first) }
        #expect(cache.parseCount == before + 1)
        #expect(first == MarkdownParser.parse(text))
    }

    @Test func differentTextsDoNotShareAnEntry() {
        let cache = MarkdownBlockCache()
        #expect(cache.blocks(for: "alpha cache test") != cache.blocks(for: "beta cache test"))
    }
}
