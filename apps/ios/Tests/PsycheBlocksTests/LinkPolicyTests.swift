import Foundation
import Testing

@testable import PsycheBlocks

struct LinkPolicyTests {
    @Test func onlyHttpHttpsAndInAppRoutesSurviveInMarkdown() {
        let text = MarkdownBlock.inline(
            "[web](https://example.com/a) [plain](http://example.org) [route](psyche://chat/thr_1) "
                + "[js](javascript:alert(1)) [file](file:///etc/passwd) [tel](tel:123) [data](data:text/html,x) [other](tailscale://x)")
        var kept: [String] = []
        for run in text.runs { if let link = run.link { kept.append(link.absoluteString) } }
        #expect(kept == ["https://example.com/a", "http://example.org", "psyche://chat/thr_1"])
    }

    @Test func externalLinksCarryTheirHostForTheConfirmation() throws {
        #expect(LinkPolicy.decision(for: try #require(URL(string: "https://Example.COM/x"))) == .confirmExternal(host: "example.com"))
        #expect(LinkPolicy.decision(for: try #require(URL(string: "psyche://chat/thr_1"))) == .internalRoute)
        #expect(LinkPolicy.decision(for: try #require(URL(string: "https://user:pw@example.com"))) == .blocked)
        #expect(LinkPolicy.decision(for: try #require(URL(string: "mailto:a@b.co"))) == .blocked)
        #expect(LinkPolicy.decision(for: try #require(URL(string: "javascript:alert(1)"))) == .blocked)
    }
}
