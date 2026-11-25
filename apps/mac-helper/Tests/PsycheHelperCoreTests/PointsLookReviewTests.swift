import CoreGraphics
import Foundation
import PsycheProtocol
import Testing

@testable import PsycheHelperCore

/// Review round 1 of #1684: what a look must not miss, and what it must not look at.
@Suite("Points look: review round 1")
struct PointsLookReviewTests {
    // MARK: Deep fields (the reviewer's probe)

    private func run(depth: Int) -> (PointsMaskFrames, CGRect) {
        let src = FakePointsSource()
        src.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        var parent = src.webArea
        for _ in 0..<depth { parent = src.add(role: "AXGroup", to: parent) }
        let pw = CGRect(x: 40, y: 100, width: 200, height: 24)
        src.add(role: "AXTextField", to: parent, subrole: "AXSecureTextField", title: "Password", value: "", frame: pw)
        let e = PointsEngine(source: src, target: .fake) { _ in }
        _ = e.begin(at: 0)
        return (e.maskFrames(at: 1), pw)
    }

    /// A deep tree recurses deep: run it on a thread with a big stack, as the session's observer thread has.
    private func runDeep(depth: Int) -> (PointsMaskFrames, CGRect) {
        final class Out: @unchecked Sendable {
            var value: (PointsMaskFrames, CGRect)?
        }
        let out = Out()
        let sem = DispatchSemaphore(value: 0)
        let t = Thread {
            out.value = self.run(depth: depth)
            sem.signal()
        }
        t.stackSize = 64 << 20
        t.start()
        sem.wait()
        return out.value!
    }

    @Test func aSecureFieldDeeperThanTheDepthCapMakesTheMaskIncomplete() {
        let (m, _) = runDeep(depth: 85)
        #expect(!m.complete, "a subtree cut at maxDepth must not read as a complete mask")
    }

    @Test func aShallowSecureFieldIsPaintedAndTheMaskIsComplete() {
        let (m, pw) = run(depth: 10)
        #expect(m.complete && m.frames.contains(pw))
        // Control for the depth rows: just under the cap still works.
        let (edge, epw) = runDeep(depth: 70)
        #expect(edge.complete && edge.frames.contains(epw))
    }

    // MARK: Directions-only pages

    @Test func aCheckoutPageIsReportedDirectionsOnlyAndAPlainFormIsNot() {
        let shop = FakePointsSource()
        shop.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        shop.add(role: "AXTextField", title: "Name", value: "", frame: CGRect(x: 10, y: 10, width: 100, height: 20))
        shop.add(role: "AXTextField", title: "Card number", value: "", frame: CGRect(x: 10, y: 50, width: 100, height: 20))
        let e = PointsEngine(source: shop, target: .fake) { _ in }
        _ = e.begin(at: 0)
        #expect(e.maskFrames(at: 1).directionsOnly)

        let plain = FakePointsSource()
        plain.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        plain.add(role: "AXTextField", title: "Name", value: "", frame: CGRect(x: 10, y: 10, width: 100, height: 20))
        let p = PointsEngine(source: plain, target: .fake) { _ in }
        _ = p.begin(at: 0)
        #expect(!p.maskFrames(at: 1).directionsOnly)
    }

    @Test func aPlainHttpPageIsDirectionsOnly() {
        let src = FakePointsSource(url: "http://shop.example/form")
        src.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        src.add(role: "AXTextField", title: "Name", value: "", frame: CGRect(x: 10, y: 10, width: 100, height: 20))
        let e = PointsEngine(source: src, target: .fake) { _ in }
        _ = e.begin(at: 0)
        #expect(e.maskFrames(at: 1).directionsOnly)
    }

    @Test func aMinimizedWindowIsNotCompleteAndARestoredOneIs() {
        let src = FakePointsSource()
        src.attrs[0]?.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        src.add(role: "AXTextField", title: "Name", value: "", frame: CGRect(x: 10, y: 10, width: 100, height: 20))
        let e = PointsEngine(source: src, target: .fake) { _ in }
        _ = e.begin(at: 0)
        e.notify(.windowMiniaturized(true), at: 1)
        #expect(!e.maskFrames(at: 2).complete)
        e.notify(.windowMiniaturized(false), at: 3)
        #expect(e.maskFrames(at: 4).complete)
    }

    // MARK: The value a box may carry

    @Test func aBoxValueIsDroppedWhereItMustBe() {
        let v = "Ada Lovelace"
        #expect(PointsBoxPolicy.value(v, touchesMask: false, masksComplete: true, directionsOnly: false) == v, "control")
        #expect(PointsBoxPolicy.value(v, touchesMask: true, masksComplete: true, directionsOnly: false) == nil)
        #expect(PointsBoxPolicy.value(v, touchesMask: false, masksComplete: false, directionsOnly: false) == nil)
        #expect(PointsBoxPolicy.value(v, touchesMask: false, masksComplete: true, directionsOnly: true) == nil)
        #expect(PointsBoxPolicy.value(nil, touchesMask: false, masksComplete: true, directionsOnly: false) == nil)
        #expect(PointsBoxPolicy.value("4111 1111 1111 1111", touchesMask: false, masksComplete: true, directionsOnly: false) == nil, "a secret shape never goes")
    }

    // MARK: Minting the id

    @Test func onlyLookAndNextInVisionModeMintAnId() {
        let all: [PointsCardAction] = [.back, .skip, .wrong, .stuckMissing, .stuckUnclear, .stuckBlocked, .ask, .look, .next, .followWindow, .stop]
        for a in all {
            #expect(PointsActionTokens.mints(a, visionMode: false) == (a == .look), "\(a) off")
            #expect(PointsActionTokens.mints(a, visionMode: true) == (a == .look || a == .next), "\(a) on")
        }
    }

    @Test func theDefaultClockCountsSleep() {
        // `systemUptime` stops while the Mac sleeps; the clock the ids use does not, so it is never behind it.
        let a = PointsActionTokens.continuousNow()
        let b = PointsActionTokens.continuousNow()
        #expect(b >= a)
        #expect(a >= ProcessInfo.processInfo.systemUptime - 1)
    }

    // MARK: Drift between the two reads

    @Test func framesThatDriftBeyondTheMarginAreMoved() {
        let f = CGRect(x: 40, y: 100, width: 200, height: 24)
        #expect(!PointsFrameDrift.moved([f], [f]))
        #expect(!PointsFrameDrift.moved([f], [f.offsetBy(dx: 0, dy: 5)]))
        #expect(PointsFrameDrift.moved([f], [f.offsetBy(dx: 0, dy: 7)]))
        #expect(PointsFrameDrift.moved([f], [f.offsetBy(dx: 40, dy: 0)]))
        #expect(PointsFrameDrift.moved([f], []), "a field that vanished")
        #expect(PointsFrameDrift.moved([], [f]), "a field that appeared")
        #expect(!PointsFrameDrift.moved([], []))
    }
}
