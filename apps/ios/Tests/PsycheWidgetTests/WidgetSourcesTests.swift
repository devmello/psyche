import Foundation
import Testing

@testable import PsycheBlocks
@testable import PsycheStore

/// Sources behind a widget or a document: decoding with and without them, the route-safety table, and the chip
/// tap, which calls the navigation closure for a safe route only.
@Suite struct WidgetSourcesTests {
    private static let root = #"{"type":"text","id":"t1","text":"Hello"}"#

    private static func specJSON(sources: String?) -> String {
        let extra = sources.map { #","sources":\#($0)"# } ?? ""
        return #"{"v":1,"title":"Trip","fallbackText":"Trip plan","root":\#(root)\#(extra)}"#
    }

    @Test func decodesWidgetWithoutSourcesAsBefore() throws {
        let spec = try WidgetSpec(json: Self.specJSON(sources: nil))
        #expect(spec.sources.isEmpty)
        #expect(spec.title == "Trip")
        #expect(spec.fallbackText == "Trip plan")
    }

    @Test func decodesWidgetWithSources() throws {
        let sources = #"[{"id":"s1","title":"Flight","source":"mail","route":"/library/f1","span":"Gate 4","date":"2026-11-02","provenance":"untrusted","kind":"mail"},{"id":"s2","title":"Note","source":"notes"}]"#
        let spec = try WidgetSpec(json: Self.specJSON(sources: sources))
        #expect(spec.sources.count == 2)
        #expect(spec.sources[0] == SourceRef(id: "s1", title: "Flight", source: "mail", route: "/library/f1", span: "Gate 4", date: "2026-11-02", isUntrusted: true))
        #expect(spec.sources[1].route == nil)
        #expect(spec.sources[1].canOpen == false)
    }

    @Test func dropsSourcesWithoutIdAndCapsTheList() throws {
        var items = [#"{"title":"no id"}"#, #"{"id":"","title":"empty id"}"#]
        items += (1...25).map { #"{"id":"s\#($0)","title":"T\#($0)"}"# }
        let spec = try WidgetSpec(json: Self.specJSON(sources: "[" + items.joined(separator: ",") + "]"))
        #expect(spec.sources.count == SourceRef.maxCount)
        #expect(spec.sources.first?.id == "s1")
    }

    @Test func nonListSourcesReadAsNone() throws {
        let spec = try WidgetSpec(json: Self.specJSON(sources: #""oops""#))
        #expect(spec.sources.isEmpty)
    }

    @Test func routeSafetyTable() {
        let safe = ["/", "/chat/thr_1", "/library/file-9", "/goals/g1", "/people/p2", "/spaces/s3", "/a-b_c.d"]
        for route in safe {
            #expect(SourceRoute.isSafe(route), "should open \(route)")
        }
        let refused: [String?] = [
            nil, "", "chat/thr_1", "//evil.example/x", "/\\evil.example", "https://evil.example",
            "javascript:alert(1)", "psyche://chat/x", " /chat/x", "/chat/x ", "/chat/\n1", "/chat/\u{0007}1",
            "/chat/\u{202E}gnp", "/chat/\u{200B}1", "/chat/x?y=1", "/chat/x#frag", "/chat/a:b",
            "/\u{00A0}chat", "/" + String(repeating: "a", count: SourceRoute.maxLength),
        ]
        for route in refused {
            #expect(!SourceRoute.isSafe(route), "should refuse \(String(describing: route))")
        }
    }

    @MainActor @Test func chipTapCallsNavigationForSafeRouteOnly() {
        var opened: [String] = []
        let navigate: @MainActor (String) -> Bool = { opened.append($0); return true }

        let safe = SourceRef(id: "s1", title: "Flight", route: "/library/f1")
        #expect(SourceChipRow.open(safe, with: navigate))

        let unsafe = [
            SourceRef(id: "s2", title: "Web", route: "//evil.example/x"),
            SourceRef(id: "s3", title: "Scheme", route: "https://evil.example"),
            SourceRef(id: "s4", title: "None", route: nil),
        ]
        for source in unsafe {
            #expect(!SourceChipRow.open(source, with: navigate))
        }
        #expect(opened == ["/library/f1"])
        #expect(!SourceChipRow.open(safe, with: nil))
    }
}
