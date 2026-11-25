import CoreGraphics
import Foundation
import PsycheProtocol
import Testing

@testable import PsycheHelperCore

/// Security review of #1674: every planted probe is a row here.

@Suite("Points rule tables are fresh")
struct PointsRuleTablesFreshnessTests {
    private struct Tables: Decodable {
        struct Word: Decodable { var reason: String; var source: String }
        var words: [Word]
        var benign: [String]
        var confusables: [String: String]
        var venueDomains: [String]
    }

    @Test func swiftTablesEqualTheGeneratedJson() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        let data = try Data(contentsOf: url.appendingPathComponent("packages/protocol/test/fixtures/points-tables.json"))
        let t = try JSONDecoder().decode(Tables.self, from: data)
        #expect(PointsRuleTables.words.map(\.reason) == t.words.map(\.reason))
        #expect(PointsRuleTables.words.map(\.source) == t.words.map(\.source))
        #expect(PointsRuleTables.benign == t.benign)
        #expect(PointsRuleTables.confusables == t.confusables)
        #expect(PointsRuleTables.venueDomains == t.venueDomains)
    }
}

@Suite("Points value rules")
struct PointsValueRuleTests {
    @Test func sharedValueRows() throws {
        let fixture = try PointsSensitiveFixture.load()
        for row in fixture.valueShapes.mustBeSensitive {
            #expect(PointsValueRules.classify(row.value, label: row.label ?? "")?.rawValue == row.reason, "\(row.value)")
        }
        for row in fixture.valueShapes.mustNotBe {
            #expect(PointsValueRules.classify(row.value, label: row.label ?? "") == nil, "\(row.value)")
        }
    }

    @Test func reviewProbes() {
        for v in ["4111–1111–1111–1111", "078051120", "GB82 WEST 1234 5698 7654 32", "DE89 3704 0044 0532 0130 00"] {
            #expect(PointsValueRules.classify(v) != nil, "\(v) must be a secret")
        }
        for v in ["90210", "Acme Corp", "03/04/1985"] { #expect(PointsValueRules.classify(v) == nil, "\(v)") }
    }

    @Test func teachWordsUseTheAsciiWordBoundary() {
        for label in ["IBAN番号", "OTP認証", "IBAN号码", "IBAN번호", "PIN番号", "PWD입력"] {
            #expect(PointsSensitiveJudge.classify(PointsFieldFacts(label: label)) != nil, "\(label)")
        }
    }
}

@Suite("Points engine: a field that turns sensitive after the digest")
struct PointsLatchTests {
    final class Sink: @unchecked Sendable { var events: [PointsSessionEvent] = [] }

    private func make(_ src: FakePointsSource) -> (PointsEngine<FakePointsSource>, Sink) {
        let sink = Sink()
        return (PointsEngine(source: src, target: .fake) { sink.events.append($0) }, sink)
    }

    @Test func secureEventInputAfterTheDigestStopsEveryRead() {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextField", title: "Custom", value: "hunter2", count: 7)
        let b = src.add(role: "AXTextField", title: "Other", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        src.resetReads()
        src.secureInput = true
        src.focused = a
        engine.notify(.focusChanged(a), at: 1)
        engine.notify(.valueChanged(a), at: 1.1)
        engine.tick(at: 1.6)
        src.focused = b
        engine.notify(.focusChanged(b), at: 2)
        #expect(!src.valueReads.contains(a), "no AXValue read after the field turned secure")
        #expect(sink.events.allSatisfy { $0.value == nil })
    }

    @Test func secureInputTurnedOnAfterFocusIsCaughtOnTheValueChange() {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextField", title: "Custom", value: "", count: 14)
        let b = src.add(role: "AXTextField", title: "Other", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        src.focused = a
        engine.notify(.focusChanged(a), at: 1)  // Secure Event Input is still off here
        src.resetReads()
        src.secureInput = true  // a paste or autofill into a custom password field
        src.values[a] = "hunter2hunter2"
        engine.notify(.valueChanged(a), at: 1.05)
        src.focused = b
        engine.notify(.focusChanged(b), at: 1.1)  // tab away inside the 300 ms
        #expect(src.valueReads.isEmpty, "0 value reads")
        #expect(sink.events.allSatisfy { $0.value == nil })
    }

    @Test func aRelabelToCardNumberBeforeTheReReadIsJudgedAtCommit() {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextField", title: "Reference", value: "")
        let b = src.add(role: "AXTextField", title: "Other", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        engine.notify(.focusChanged(a), at: 1)
        src.attrs[a]?.title = "Card number"
        src.values[a] = "4111111111111111"
        src.resetReads()
        engine.notify(.focusChanged(b), at: 1.1)  // inside the 400 ms: no re-read yet
        #expect(!src.valueReads.contains(a))
        #expect(sink.events.allSatisfy { $0.value == nil })
    }

    @Test func aPlaceholderRelabelIsJudgedToo() {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextField", title: "Field", value: "")
        let b = src.add(role: "AXTextField", title: "Other", value: "")
        let (engine, _) = make(src)
        engine.begin(at: 0)
        engine.notify(.focusChanged(a), at: 1)
        src.attrs[a]?.placeholder = "Social Security number"
        src.values[a] = "x"
        src.resetReads()
        engine.notify(.focusChanged(b), at: 2)
        #expect(!src.valueReads.contains(a))
    }

    @Test func sensitivityIsNeverClearedByARelabel() throws {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextField", title: "Social Security number", value: "123456789", count: 9)
        let (engine, _) = make(src)
        engine.begin(at: 0)
        src.attrs[a]?.title = "Reference"
        src.resetReads()
        engine.notify(.layoutChanged, at: 1)
        engine.tick(at: 1.5)
        engine.notify(.focusChanged(a), at: 2)
        engine.notify(.focusChanged(nil), at: 3)
        #expect(src.valueReads.isEmpty, "a node ever judged sensitive is never read again")
        let id = engine.fieldId(for: a)
        #expect(id.flatMap { engine.record($0)?.sensitive } == .identity)
    }

    @Test func aTextFieldInsideASensitiveComboBoxIsSensitive() throws {
        let src = FakePointsSource()
        let combo = src.add(role: "AXComboBox", title: "Password", value: "")
        let inner = src.add(role: "AXTextField", to: combo, value: "secret")
        var ids = PointsFieldIds<Int>()
        let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
        #expect(read.records.first { $0.node == inner }?.sensitive != nil)
        #expect(!src.valueReads.contains(inner))
    }

    @Test func aFullReadStopsWhenItsBudgetIsSpent() throws {
        let src = FakePointsSource()
        for i in 0..<50 { src.add(role: "AXTextField", title: "Field \(i)", value: "") }
        var ids = PointsFieldIds<Int>()
        let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids, budget: -1))
        #expect(read.digest.truncated == true)
        #expect(read.digest.fields.count < 50)
    }
}

@Suite("Points session limit")
struct PointsSessionLimitTests {
    final class Clock: @unchecked Sendable {
        let lock = NSLock()
        var asked: [UInt64] = []
        var expired = 0
    }

    @Test func endsASessionAfterThirtyMinutesOnTheInjectedClock() async {
        #expect(PointsSessionLimit.maxSeconds == 1800)
        let c = Clock()
        let t = PointsSessionLimit.watch(sleep: { s in c.lock.withLock { c.asked.append(s) }; return true }, onExpire: { c.lock.withLock { c.expired += 1 } })
        await t.value
        #expect(c.asked == [1800] && c.expired == 1)
    }

    @Test func aCancelledWatchNeverExpires() async {
        let c = Clock()
        let t = PointsSessionLimit.watch(sleep: { _ in false }, onExpire: { c.lock.withLock { c.expired += 1 } })
        t.cancel()
        await t.value
        #expect(c.expired == 0)
    }
}
