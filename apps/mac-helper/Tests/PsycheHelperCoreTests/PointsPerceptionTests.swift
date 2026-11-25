import CoreGraphics
import Foundation
import PsycheProtocol
import Testing

@testable import PsycheHelperCore

/// Builds one window holding one field the way a fixture row describes it.
private func window(for row: PointsSensitiveFixture.Field, value: String = "TOPSECRET-value") -> (FakePointsSource, Int) {
    let src = FakePointsSource()
    var parent = src.container
    for title in row.path ?? [] { parent = src.add(role: "AXGroup", to: parent, title: title) }
    for text in row.nearbyText ?? [] { src.add(role: "AXStaticText", to: parent, text: text) }
    let role = row.secure == true ? "AXSecureTextField" : "AXTextField"
    let field = src.add(
        role: role, to: parent, title: row.label, placeholder: row.placeholder, help: row.help, identifier: row.identifier ?? row.autocomplete,
        value: value, count: 7)
    return (src, field)
}

@Suite("Points perception: no AXValue for a sensitive field")
struct PointsNoValueReadTests {
    @Test func noValueIsReadForAnySensitiveRow() throws {
        let fixture = try PointsSensitiveFixture.load()
        var leaked: [String] = []
        var judgedPlain: [String] = []
        for row in fixture.mustBeSensitive {
            let (src, field) = window(for: row)
            var ids = PointsFieldIds<Int>()
            let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
            let rec = try #require(read.records.first { $0.node == field })
            if rec.sensitive == nil { judgedPlain.append(row.label) }
            if src.valueReads.contains(field) { leaked.append(row.label) }
            if rec.fill != .unknown { leaked.append("\(row.label) fill") }
            let wire = try #require(read.digest.fields.first)
            if wire.value != nil || wire.sensitive == nil && rec.sensitive != nil { leaked.append("\(row.label) wire") }
        }
        #expect(leaked.isEmpty, "AXValue read for: \(leaked.joined(separator: "; "))")
        // Rows the AX source cannot express (an autocomplete token has no AX attribute) are still judged here
        // through the identifier; every row of the shared table must come out sensitive.
        #expect(judgedPlain.isEmpty, "judged plain: \(judgedPlain.joined(separator: "; "))")
    }

    @Test func positiveControlPlainRowsAreRead() throws {
        // The test above would also pass if the builder never read anything: near-misses are read once each.
        let fixture = try PointsSensitiveFixture.load()
        var notRead: [String] = []
        for row in fixture.mustNotBeSensitive {
            let (src, field) = window(for: row, value: "hello")
            var ids = PointsFieldIds<Int>()
            let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
            let rec = try #require(read.records.first { $0.node == field })
            if rec.sensitive != nil || src.valueReads != [field] || rec.fill != .filled { notRead.append(row.label) }
        }
        #expect(notRead.isEmpty, "near-misses not read as plain: \(notRead.joined(separator: "; "))")
    }

    @Test func sensitiveWireFieldCarriesOnlyTheAllowedFacts() throws {
        let src = FakePointsSource()
        src.add(role: "AXTextField", title: "Social Security number", value: "123-45-6789", invalid: true)
        src.add(role: "AXStaticText", text: "Not a valid number 123-45-6789")
        var ids = PointsFieldIds<Int>()
        let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
        let f = try #require(read.digest.fields.first)
        #expect(f.sensitive == .identity)
        #expect(f.value == nil && f.errorText == nil && f.options == nil && f.invalid == nil)
        #expect(f.state == .unknown)
        #expect(src.valueReads.isEmpty)
        // Page text shaped like a secret is not in the instructions either.
        #expect(!read.digest.instructions.contains("123-45"))
    }

    @Test func secureEventInputMakesTheFocusedFieldSecure() throws {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextField", title: "Nickname", value: "x")
        let b = src.add(role: "AXTextField", title: "Hobby", value: "y")
        src.secureInput = true
        src.focused = a
        var ids = PointsFieldIds<Int>()
        let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
        #expect(read.records.first { $0.node == a }?.sensitive == .secureField)
        #expect(read.records.first { $0.node == b }?.sensitive == nil)
        #expect(src.valueReads == [b])
    }

    @Test func directionsOnlyPageReadsNothing() throws {
        let src = FakePointsSource(url: "https://shop.example/checkout/pay")
        src.add(role: "AXTextField", title: "Gift message", value: "hi")
        src.add(role: "AXTextField", title: "Name", value: "Ann")
        var ids = PointsFieldIds<Int>()
        let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
        #expect(read.directionsOnly)
        #expect(read.digest.fields.allSatisfy { $0.sensitive == .directionsOnly })
        #expect(src.valueReads.isEmpty)
    }

    @Test func plainHttpPageIsDirectionsOnly() throws {
        let src = FakePointsSource(url: "http://forms.example.org/apply?token=abc#frag")
        src.add(role: "AXTextField", title: "Name", value: "Ann")
        var ids = PointsFieldIds<Int>()
        let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
        #expect(read.digest.insecure == true)
        #expect(read.digest.path == "/apply")  // no query, no fragment
        #expect(read.digest.host == "forms.example.org")
        #expect(src.valueReads.isEmpty)
    }
}

@Suite("Points perception: digest")
struct PointsDigestTests {
    private func plainPage() -> (FakePointsSource, [Int]) {
        let src = FakePointsSource()
        src.add(role: "AXHeading", text: "Applicant details")
        let a = src.add(role: "AXTextField", title: "First name", value: "Ann", frame: CGRect(x: 10, y: 20, width: 100, height: 20))
        let b = src.add(role: "AXTextField", title: "Employer", value: "")
        let c = src.add(role: "AXCheckBox", title: "I agree", value: "0")
        src.add(role: "AXButton", title: "Next")
        return (src, [a, b, c])
    }

    @Test func buildsFieldsRolesAndFillState() throws {
        let (src, _) = plainPage()
        var ids = PointsFieldIds<Int>()
        let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
        let f = read.digest.fields
        #expect(f.map(\.label) == ["First name", "Employer", "I agree", "Next"])
        #expect(f.map(\.role) == [.text, .text, .checkbox, .button])
        #expect(f.map(\.state) == [.filled, .empty, .empty, .unknown])
        #expect(f.allSatisfy { $0.value == nil })
        #expect(f.first?.path == ["Applicant details"])
        #expect(f.map(\.fieldID) == ["f1", "f2", "f3", "f4"])
        #expect(read.digest.headings == ["Applicant details"])
        #expect(read.digest.tree == .ok)
        #expect(read.digest.host == "example.org")
    }

    @Test func fingerprintIgnoresValuesAndFocusButNotANewPage() throws {
        let (src, fields) = plainPage()
        var ids = PointsFieldIds<Int>()
        let first = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids)).digest.fingerprint
        src.values[fields[1]] = "Acme"
        src.values[fields[0]] = "Bob"
        src.focused = fields[1]
        src.attrs[fields[0]]?.frame = CGRect(x: 0, y: 500, width: 9, height: 9)
        let afterValue = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids)).digest.fingerprint
        #expect(afterValue == first)
        // A new page: other fields.
        let page2 = FakePointsSource()
        page2.add(role: "AXTextField", title: "Spouse name", value: "")
        page2.add(role: "AXTextField", title: "Date of marriage", value: "")
        var ids2 = PointsFieldIds<Int>()
        let second = try #require(PointsDigestBuilder.read(source: page2, target: .fake, ids: &ids2)).digest.fingerprint
        #expect(second != first)
        // The same labels under another heading are another page too (label paths).
        let (other, _) = plainPage()
        other.attrs[other.kids[other.container]![0]]?.text = "Spouse details"
        var ids3 = PointsFieldIds<Int>()
        #expect(try #require(PointsDigestBuilder.read(source: other, target: .fake, ids: &ids3)).digest.fingerprint != first)
    }

    @Test func fieldIdsAreStableAndNeverReassigned() throws {
        let (src, fields) = plainPage()
        var ids = PointsFieldIds<Int>()
        _ = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
        // A new field before the others and a removed one: the old ids stay with their elements.
        let inserted = src.add(role: "AXTextField", title: "Middle name", value: "")
        var order = src.kids[src.container] ?? []
        order.insert(order.removeLast(), at: 0)
        order.removeAll { $0 == fields[0] }
        src.kids[src.container] = order
        let read = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids))
        #expect(ids.existingId(for: fields[1]) == "f2")
        #expect(ids.existingId(for: fields[0]) == "f1")  // gone from the page, not reused
        #expect(read.records.first { $0.node == inserted }?.id == "f5")
        #expect(Set(read.records.map(\.id)).count == read.records.count)
    }

    @Test func sparseTreeAndCaps() throws {
        let sparse = FakePointsSource()
        sparse.add(role: "AXTextField", title: "Only one", value: "")
        var ids = PointsFieldIds<Int>()
        #expect(try #require(PointsDigestBuilder.read(source: sparse, target: .fake, ids: &ids)).digest.tree == .sparse)

        let big = FakePointsSource()
        for i in 0..<400 { big.add(role: "AXTextField", title: "Field \(i)", value: "") }
        var ids2 = PointsFieldIds<Int>()
        let read = try #require(PointsDigestBuilder.read(source: big, target: .fake, ids: &ids2))
        #expect(read.digest.fields.count == PointsDigestBuilder.maxEmit)
        #expect(read.digest.truncated == true)
    }

    @Test func errorTextAndLabelsFromTheTree() throws {
        let src = FakePointsSource()
        src.add(role: "AXTextField", title: "Email", value: "a@b", invalid: true)
        src.add(role: "AXStaticText", text: "Enter a valid email address")
        src.add(role: "AXTextField", placeholder: "Phone", value: "")
        var ids = PointsFieldIds<Int>()
        let f = try #require(PointsDigestBuilder.read(source: src, target: .fake, ids: &ids)).digest.fields
        #expect(f[0].errorText == "Enter a valid email address")
        #expect(f[0].invalid == true)
        #expect(f[1].label == "Phone")
    }
}

@Suite("Points perception: engine")
struct PointsEngineTests {
    final class Sink: @unchecked Sendable {
        var events: [PointsSessionEvent] = []
    }

    private func make(_ src: FakePointsSource) -> (PointsEngine<FakePointsSource>, Sink) {
        let sink = Sink()
        let engine = PointsEngine(source: src, target: .fake) { sink.events.append($0) }
        return (engine, sink)
    }

    @Test func aValueIsSentOnlyOnCommit() throws {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextField", title: "Employer", value: "")
        let b = src.add(role: "AXTextField", title: "City", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        #expect(sink.events.map(\.type) == [.digest])
        let fa = try #require(engine.fieldId(for: a))
        let fb = try #require(engine.fieldId(for: b))
        engine.notify(.focusChanged(a), at: 1)
        // The owner types: three value changes inside 300 ms.
        for (i, text) in ["A", "Ac", "Acm"].enumerated() {
            src.values[a] = text
            engine.notify(.valueChanged(a), at: 1.0 + Double(i) * 0.05)
        }
        engine.tick(at: 1.2)
        #expect(sink.events.filter { $0.type == .field }.isEmpty, "nothing before the 300 ms of quiet")
        src.values[a] = "Acme"
        engine.notify(.valueChanged(a), at: 1.25)
        engine.tick(at: 1.56)
        var fields = sink.events.filter { $0.type == .field }
        #expect(fields.count == 1)
        #expect(fields[0].fieldID == fa && fields[0].state == .filled && fields[0].value == nil, "typing sends filled, never the value")
        // Focus leaves the field: the commit carries the value, once.
        engine.notify(.focusChanged(b), at: 2)
        fields = sink.events.filter { $0.type == .field }
        #expect(fields.count == 2)
        #expect(fields[1].fieldID == fa && fields[1].value == "Acme")
        #expect(sink.events.last?.type == .focus && sink.events.last?.fieldID == fb)
        // Back and out again without a change: no second send.
        engine.notify(.focusChanged(a), at: 3)
        engine.notify(.focusChanged(b), at: 4)
        #expect(sink.events.filter { $0.type == .field && $0.fieldID == fa }.count == 2, "the value is not sent twice")
        #expect(sink.events.filter { $0.type == .field }.allSatisfy { $0.fieldID == fa || $0.fieldID == fb })
        // Every value that left was on a commit event.
        #expect(sink.events.filter { $0.value != nil }.count == 1)
    }

    @Test func aSensitiveFieldNeverHasItsValueReadOrSent() throws {
        let src = FakePointsSource()
        let ssn = src.add(role: "AXTextField", title: "Social Security number", value: "123456789", count: 9)
        let other = src.add(role: "AXTextField", title: "Nickname", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        src.resetReads()
        engine.notify(.focusChanged(ssn), at: 1)
        src.values[ssn] = "123456789"
        engine.notify(.valueChanged(ssn), at: 1.1)
        engine.tick(at: 1.6)
        engine.notify(.focusChanged(other), at: 2)
        #expect(src.valueReads.isEmpty, "no AXValue read for the sensitive field")
        #expect(src.countReads == [ssn], "one character-count read, when focus left")
        let fields = sink.events.filter { $0.type == .field }
        #expect(fields.count == 1 && fields[0].state == .filled && fields[0].value == nil)
        // A later digest reports the state it learned, still with no value.
        engine.notify(.layoutChanged, at: 3)
        engine.tick(at: 3.5)
        let digest = try #require(sink.events.last { $0.type == .digest }?.digest)
        let f = try #require(digest.fields.first { $0.label == "Social Security number" })
        #expect(f.state == .filled && f.value == nil && f.sensitive == .identity)
        #expect(!src.valueReads.contains(ssn))
    }

    @Test func aSecretShapedValueIsDroppedAndTheFieldTurnsSensitive() throws {
        let src = FakePointsSource()
        let note = src.add(role: "AXTextField", title: "Notes", value: "")
        let next = src.add(role: "AXTextField", title: "Other", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        engine.notify(.focusChanged(note), at: 1)
        src.values[note] = "4111 1111 1111 1111"
        engine.notify(.focusChanged(next), at: 2)
        let commit = try #require(sink.events.first { $0.type == .field })
        #expect(commit.value == nil && commit.state == .filled)
        #expect(sink.events.allSatisfy { $0.value == nil })
        let id = try #require(engine.fieldId(for: note))
        #expect(engine.record(id)?.sensitive == .valueShape)
        src.resetReads()
        engine.notify(.layoutChanged, at: 3)
        engine.tick(at: 3.5)
        #expect(!src.valueReads.contains(note), "after the shape hit, the field is read no more")
        #expect(sink.events.last { $0.type == .digest }?.digest?.fields.first { $0.fieldID == id }?.sensitive == .valueShape)
    }

    @Test func aValueOverFiveHundredCharactersIsCut() throws {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextArea", title: "About you", value: "")
        let b = src.add(role: "AXTextField", title: "Other", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        engine.notify(.focusChanged(a), at: 1)
        src.values[a] = String(repeating: "word ", count: 300)
        engine.notify(.focusChanged(b), at: 2)
        #expect(sink.events.first { $0.value != nil }?.value?.count == 500)
    }

    @Test func aNewPageSendsPageThenDigestAndAValueChangeDoesNot() throws {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextField", title: "First name", value: "")
        src.add(role: "AXTextField", title: "Last name", value: "")
        src.add(role: "AXTextField", title: "Employer", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        // A value changes and the page re-lays out: a digest, no page event.
        src.values[a] = "Ann"
        engine.notify(.layoutChanged, at: 1)
        engine.tick(at: 1.5)
        #expect(sink.events.map(\.type) == [.digest, .digest])
        // The page is replaced.
        src.kids[src.container] = []
        for t in ["Spouse", "Marriage date", "Place"] { src.add(role: "AXTextField", title: t, value: "") }
        engine.notify(.layoutChanged, at: 3)
        engine.tick(at: 3.5)
        #expect(sink.events.map(\.type) == [.digest, .digest, .page, .digest])
    }

    @Test func focusOnAnUnknownElementReadsAgainThenReportsFocus() throws {
        let src = FakePointsSource()
        src.add(role: "AXTextField", title: "One", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        let late = src.add(role: "AXTextField", title: "Appeared later", value: "")
        engine.notify(.focusChanged(late), at: 1)
        #expect(sink.events.map(\.type) == [.digest])
        engine.tick(at: 1.5)
        #expect(sink.events.map(\.type) == [.digest, .page, .digest, .focus])
        #expect(sink.events.last?.fieldID == engine.fieldId(for: late))
    }

    @Test func endsAndVisibility() {
        let src = FakePointsSource()
        src.add(role: "AXTextField", title: "One", value: "")
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        engine.notify(.appActive(false), at: 1)
        engine.notify(.appActive(false), at: 1.1)
        engine.notify(.appActive(true), at: 2)
        engine.notify(.windowMiniaturized(true), at: 3)
        #expect(sink.events.filter { $0.type == .visible }.map(\.visible) == [false, true, false])
        engine.notify(.windowDestroyed, at: 4)
        #expect(sink.events.last?.type == .ended && sink.events.last?.reason == .windowClosed)
        let n = sink.events.count
        engine.notify(.appTerminated, at: 5)
        engine.notify(.layoutChanged, at: 6)
        engine.tick(at: 7)
        #expect(sink.events.count == n, "nothing after the end")
    }

    @Test func appQuitEnds() {
        let src = FakePointsSource()
        let (engine, sink) = make(src)
        engine.begin(at: 0)
        engine.notify(.appTerminated, at: 1)
        #expect(sink.events.last?.reason == .appQuit)
    }

    @Test func framesAreReReadForWatchedFieldsOnly() throws {
        let src = FakePointsSource()
        let a = src.add(role: "AXTextField", title: "A", value: "", frame: CGRect(x: 0, y: 0, width: 10, height: 10))
        let b = src.add(role: "AXTextField", title: "B", value: "", frame: CGRect(x: 0, y: 50, width: 10, height: 10))
        let (engine, _) = make(src)
        engine.begin(at: 0)
        var got: [String: CGRect] = [:]
        engine.onFrames = { got = $0 }
        engine.setWatched([try #require(engine.fieldId(for: a))])
        src.attrs[a]?.frame = CGRect(x: 0, y: -40, width: 10, height: 10)
        src.attrs[b]?.frame = CGRect(x: 0, y: 10, width: 10, height: 10)
        src.resetReads()
        engine.notify(.geometryChanged, at: 1)
        engine.tick(at: 1)
        #expect(got.count == 1 && got.values.first?.origin.y == -40)
        #expect(src.valueReads.isEmpty)
    }
}

@Suite("Points perception: coalescing")
struct PointsCoalescerTests {
    @Test func valueChangesCoalesceFor300ms() {
        var c = PointsCoalescer()
        c.valueChanged(fieldId: "f1", at: 0)
        c.valueChanged(fieldId: "f1", at: 0.2)
        #expect(c.due(at: 0.45).isEmpty, "the second change pushed the deadline")
        #expect(c.due(at: 0.51) == [.valueSettled(fieldId: "f1")])
        #expect(c.due(at: 5).isEmpty)
        #expect(c.nextDeadline == nil, "nothing pending, no wakeup")
    }

    @Test func layoutIsDebouncedAndOneReadHappens() {
        var c = PointsCoalescer()
        for t in stride(from: 0.0, through: 0.3, by: 0.1) { c.layoutChanged(at: t) }
        #expect(c.due(at: 0.6).isEmpty)
        #expect(c.due(at: 0.71) == [.fullRead])
        #expect(c.due(at: 0.8).isEmpty)
    }

    @Test func aPageThatNeverStopsChangingIsStillReadWithinTwoSeconds() throws {
        var c = PointsCoalescer()
        var t = 0.0
        var read: Double?
        while t < 5, read == nil {
            c.layoutChanged(at: t)
            if c.due(at: t) == [.fullRead] { read = t }
            t += 0.1
        }
        #expect(try #require(read) <= 2.1)
    }

    @Test func atMostTwoFullReadsASecond() {
        // A change every 450 ms: each debounce (400 ms) is satisfied, so only the 0.5 s gap spaces the reads.
        var c = PointsCoalescer()
        var reads: [Double] = []
        for step in 0..<400 {
            let t = Double(step) * 0.01
            if step % 45 == 0 { c.layoutChanged(at: t) }
            if c.due(at: t).contains(.fullRead) { reads.append(t) }
        }
        #expect(reads.count >= 3)
        for (a, b) in zip(reads, reads.dropFirst()) { #expect(b - a >= 0.5 - 1e-9) }
        // A burst: a 400 ms debounce satisfied at once still waits out the 0.5 s gap.
        var d = PointsCoalescer()
        d.layoutChanged(at: 0)
        #expect(d.due(at: 0.4) == [.fullRead])
        d.layoutChanged(at: 0.41)
        #expect(d.due(at: 0.81).isEmpty)
        #expect(d.due(at: 0.91) == [.fullRead])
    }

    @Test func scrollFramesAreLimitedToThirtyASecond() {
        var c = PointsCoalescer()
        c.scrolled(at: 0)
        #expect(c.due(at: 0) == [.frames])
        c.scrolled(at: 0.01)
        #expect(c.due(at: 0.02).isEmpty)
        #expect(c.due(at: 0.034) == [.frames])
        #expect(c.nextDeadline == nil)
    }
}

@Suite("Points: refusals (§2.2) and exclusion")
struct PointsPolicyTests {
    @Test func everySection22RowIsRefused() {
        let settings = TierSettings(defaultValue: .interact, apps: ["com.example.offapp": .off])
        let rows: [(String, PointsRefusal)] = [
            ("com.psyche.desktop", .neverApp), ("com.psyche.helper", .neverApp),
            ("com.apple.systempreferences", .neverApp), ("com.apple.SystemSettings", .neverApp),
            ("com.apple.loginwindow", .neverApp), ("com.apple.SecurityAgent", .neverApp),
            ("com.1password.1password", .neverApp), ("com.apple.Passwords", .neverApp), ("com.bitwarden.desktop", .neverApp),
            ("com.robinhood.macos", .fixedOff), ("com.coinbase.Coinbase", .fixedOff), ("com.chase.mac", .fixedOff),
            ("com.apple.Terminal", .terminalOrIDE), ("com.googlecode.iterm2", .terminalOrIDE), ("com.apple.dt.Xcode", .terminalOrIDE),
            ("com.microsoft.VSCode", .terminalOrIDE), ("com.jetbrains.intellij", .terminalOrIDE),
            ("com.example.offapp", .ownerOff),
        ]
        for (id, want) in rows { #expect(PointsPolicy.refusal(bundleId: id, settings: settings) == want, "\(id)") }
    }

    @Test func appsPointsMayUseAreNotRefused() {
        let settings = TierSettings(defaultValue: .ask)
        // Browsers (fixed cap Read) and plain apps, whatever tier the owner gave them.
        for id in ["com.apple.Safari", "com.google.Chrome", "org.mozilla.firefox", "company.thebrowser.Browser", "com.apple.Preview", "com.apple.Notes", "com.apple.mail"] {
            #expect(PointsPolicy.refusal(bundleId: id, settings: settings) == nil, "\(id)")
        }
        let readOnly = TierSettings(defaultValue: .read)
        #expect(PointsPolicy.refusal(bundleId: "com.apple.Safari", settings: readOnly) == nil)
    }

    @Test func oneSessionSlotAtATime() {
        let a = PointsActivity()
        #expect(!a.isActive)
        #expect(a.begin("s1"))
        #expect(a.isActive)
        #expect(!a.begin("s2"), "a second session is refused")
        #expect(!a.end("s2"), "another id cannot free the slot")
        #expect(a.isActive)
        #expect(a.end("s1"))
        #expect(!a.isActive)
        #expect(a.begin("s2"))
    }
}
