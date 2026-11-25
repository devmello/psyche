import CoreGraphics
import Foundation
import PsycheProtocol
import Testing

@testable import PsycheHelperCore

/// Review round 2 of #1684: a payment page that hides its card field from AX, and a card-shaped value in
/// an ordinary field.
@Suite("Points look: review round 2")
struct PointsLookReview2Tests {
    private func engine(_ src: FakePointsSource) -> PointsEngine<FakePointsSource> {
        src.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        let e = PointsEngine(source: src, target: .fake) { _ in }
        _ = e.begin(at: 0)
        return e
    }

    /// The reviewer's probe: an order step, an Email field, then a heading and a text with the card field
    /// hidden in a canvas or an iframe.
    private func hiddenCardPage(heading: String = "Payment details", text: String = "Card number") -> FakePointsSource {
        let src = FakePointsSource(url: "https://shop.example/order/step-3")
        src.attrs[0]?.title = "Acme Store"
        src.add(role: "AXTextField", title: "Email", value: "", frame: CGRect(x: 10, y: 10, width: 200, height: 20))
        src.add(role: "AXHeading", text: heading)
        src.add(role: "AXStaticText", text: text)
        return src
    }

    @Test func aPaymentPageThatHidesItsCardFieldIsDirectionsOnly() {
        #expect(engine(hiddenCardPage()).maskFrames(at: 1).directionsOnly)
    }

    @Test func eitherTextAloneIsEnough() {
        // The heading alone, and the card text alone, each make the page directions-only.
        #expect(engine(hiddenCardPage(heading: "Payment details", text: "Thanks for your order")).maskFrames(at: 1).directionsOnly)
        #expect(engine(hiddenCardPage(heading: "Your details", text: "Card number")).maskFrames(at: 1).directionsOnly)
    }

    @Test func aPlainSparsePageIsNotDirectionsOnly() {
        // Control: the same page with ordinary headings and texts.
        let src = hiddenCardPage(heading: "Contact details", text: "We will only use this to reach you")
        #expect(!engine(src).maskFrames(at: 1).directionsOnly)
    }

    @Test func nearMissesThatShareAWordAreNotDirectionsOnly() {
        // "Library card number" is a library page (a near-miss of §5.1); "Number of dependents" is plain.
        for text in ["Number of dependents", "Tax year", "Account name"] {
            #expect(!engine(hiddenCardPage(heading: "About you", text: text)).maskFrames(at: 1).directionsOnly, "\(text)")
        }
    }

    @Test func theDigestOfAHiddenCardPageMarksItsFieldsDirectionsOnly() {
        var events: [PointsSessionEvent] = []
        let src = hiddenCardPage()
        src.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        final class Sink: @unchecked Sendable { var events: [PointsSessionEvent] = [] }
        let sink = Sink()
        let e = PointsEngine(source: src, target: .fake) { sink.events.append($0) }
        _ = e.begin(at: 0)
        events = sink.events
        let digest = events.compactMap(\.digest).first
        #expect(digest?.fields.allSatisfy { $0.sensitive == .directionsOnly } == true)
    }

    @Test func theReadsOwnVerdictReachesTheOfferCallbackBeforeTheDigest() {
        let order = Order()
        let src = hiddenCardPage()
        src.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        let e = PointsEngine(source: src, target: .fake) { if $0.type == .digest { order.log.append("digest") } }
        e.onDirectionsOnly = { order.log.append("dirOnly=\($0)") }
        _ = e.begin(at: 0)
        #expect(order.log == ["dirOnly=true", "digest"])
    }

    private final class Order: @unchecked Sendable { var log: [String] = [] }

    // MARK: A card-shaped value in an ordinary field

    private func numberForm(_ value: String) -> (FakePointsSource, CGRect, CGRect) {
        let src = FakePointsSource()
        let number = CGRect(x: 40, y: 40, width: 200, height: 24)
        let name = CGRect(x: 40, y: 100, width: 200, height: 24)
        src.add(role: "AXTextField", title: "Number", value: value, frame: number)
        src.add(role: "AXTextField", title: "Name", value: "Ada Lovelace", frame: name)
        return (src, number, name)
    }

    @Test func aCardShapedValueInAnOrdinaryFieldIsPainted() {
        let (src, number, name) = numberForm("4111 1111 1111 1111")
        let m = engine(src).maskFrames(at: 1)
        #expect(m.complete)
        #expect(m.frames.contains(number))
        #expect(!m.frames.contains(name), "control: a plain name is not painted")
    }

    @Test func aPlainValueInTheSameFieldIsNotPainted() {
        let (src, number, _) = numberForm("12")
        #expect(!engine(src).maskFrames(at: 1).frames.contains(number))
    }

    @Test func otherSecretShapesInPlainFieldsArePaintedToo() {
        for value in ["123-45-6789", "GB82 WEST 1234 5698 7654 32"] {
            let (src, number, _) = numberForm(value)
            #expect(engine(src).maskFrames(at: 1).frames.contains(number), "\(value)")
        }
    }

    @Test func theFieldStaysPaintedAfterItsValueChanges() {
        let (src, number, _) = numberForm("4111 1111 1111 1111")
        let e = engine(src)
        _ = e.maskFrames(at: 1)
        src.values[2] = "cleared"  // node 1 is the web area; the Number field is node 2
        #expect(e.maskFrames(at: 2).frames.contains(number), "once sensitive in a session, always")
    }

    @Test func theValueIsNeverKept() {
        // The read happens, the digest carries no value, and the engine holds none: only frames come back.
        var seen: [PointsSessionEvent] = []
        final class Sink: @unchecked Sendable { var events: [PointsSessionEvent] = [] }
        let sink = Sink()
        let (src, _, _) = numberForm("4111 1111 1111 1111")
        src.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        let e = PointsEngine(source: src, target: .fake) { sink.events.append($0) }
        _ = e.begin(at: 0)
        _ = e.maskFrames(at: 1)
        seen = sink.events
        let json = seen.compactMap { try? JSONEncoder().encode($0) }.map { String(decoding: $0, as: UTF8.self) }.joined()
        #expect(!json.contains("4111"))
    }
}
