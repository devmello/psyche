import CoreGraphics
import Foundation
import PsycheProtocol
import Testing

@testable import PsycheHelperCore

/// What a picture of the window must paint over, as the engine reports it (W5): frames only, never values.
@Suite("Points: mask frames from the engine")
struct PointsMaskFramesTests {
    private final class Sink: @unchecked Sendable {
        var events: [PointsSessionEvent] = []
    }

    private func make(_ src: FakePointsSource) -> PointsEngine<FakePointsSource> {
        let sink = Sink()
        let e = PointsEngine(source: src, target: .fake) { sink.events.append($0) }
        _ = e.begin(at: 0)
        return e
    }

    private func form() -> (FakePointsSource, plain: CGRect, password: CGRect, card: CGRect) {
        let src = FakePointsSource()
        src.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        let plain = CGRect(x: 40, y: 40, width: 200, height: 24)
        let pw = CGRect(x: 40, y: 100, width: 200, height: 24)
        let card = CGRect(x: 40, y: 160, width: 200, height: 24)
        src.add(role: "AXTextField", title: "Employer", value: "", frame: plain)
        src.add(role: "AXTextField", subrole: "AXSecureTextField", title: "Password", value: "", frame: pw)
        src.add(role: "AXTextField", title: "Social Security number", value: "", frame: card)
        return (src, plain, pw, card)
    }

    @Test func theFramesOfSensitiveFieldsAreReturnedAndAPlainOneIsNot() {
        let (src, plain, pw, card) = form()
        let m = make(src).maskFrames(at: 1)
        #expect(m.complete)
        #expect(m.window == CGRect(x: 0, y: 0, width: 800, height: 600))
        #expect(m.frames.contains(pw) && m.frames.contains(card))
        #expect(!m.frames.contains(plain), "control: a plain field is not painted")
        #expect(m.frames.count == 2)
    }

    @Test func noValueIsReadForAnySensitiveFieldWhileMasking() {
        let (src, _, _, _) = form()
        src.values = [2: "Acme", 3: "hunter2", 4: "123-45-6789"]
        let engine = make(src)
        src.resetReads()
        _ = engine.maskFrames(at: 1)
        for n in src.valueReads { #expect(src.attrs[n]?.title == "Employer", "a value was read from \(src.attrs[n]?.title ?? "?")") }
    }

    @Test func aSensitiveFieldWithNoFrameMeansTheMaskCannotBeTrusted() {
        let (src, _, _, _) = form()
        src.add(role: "AXTextField", subrole: "AXSecureTextField", title: "Confirm password", value: "")
        #expect(!make(src).maskFrames(at: 1).complete)
    }

    @Test func aPlainFieldWithNoFrameDoesNotSpoilTheMask() {
        let (src, _, _, _) = form()
        src.add(role: "AXTextField", title: "Nickname", value: "")
        #expect(make(src).maskFrames(at: 1).complete)
    }

    @Test func aFieldThatTurnedSensitiveSinceTheLastReadIsPainted() {
        let (src, plain, _, _) = form()
        let engine = make(src)
        // The page relabelled the employer box into a one-time code box after the digest.
        src.attrs[2]?.title = "One-time code"
        #expect(engine.maskFrames(at: 2).frames.contains(plain))
    }

    @Test func aDirectionsOnlyPagePaintsEveryField() {
        let src = FakePointsSource(url: "http://shop.example/checkout")  // plain http: directions only (§2.2)
        src.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        let a = CGRect(x: 10, y: 10, width: 100, height: 20)
        let b = CGRect(x: 10, y: 50, width: 100, height: 20)
        src.add(role: "AXTextField", title: "Name", frame: a)
        src.add(role: "AXTextField", title: "Street", frame: b)
        let m = make(src).maskFrames(at: 1)
        #expect(m.frames.contains(a) && m.frames.contains(b))
    }

    @Test func aWindowThatIsGoneIsNotComplete() {
        let (src, _, _, _) = form()
        let engine = make(src)
        src.root = nil
        let m = engine.maskFrames(at: 2)
        #expect(!m.complete && m.window == nil)
    }
}
