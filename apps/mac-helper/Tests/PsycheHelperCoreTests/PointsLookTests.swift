import CoreGraphics
import Foundation
import Testing

@testable import PsycheHelperCore

/// Vision mode (W5), the pure parts: the action id, the look gate, the picture size, the mask rectangles
/// and the box mapping. Retina and non-Retina, one display and two, with the window partly off screen.
@Suite("Points: look gate and action ids")
struct PointsLookGateTests {
    private final class Clock: @unchecked Sendable {
        var now: Double = 100
    }

    private func tokens(_ clock: Clock = Clock()) -> PointsActionTokens {
        let n = LockedCounter()
        return PointsActionTokens(clock: { clock.now }, makeId: { "act-\(n.next())" })
    }

    private let safari = "com.apple.Safari"
    private let settings = TierSettings(defaultValue: .ask)

    private func reason(_ body: () throws -> Void) -> String? {
        do { try body(); return nil } catch let e as CapabilityError { return e.reason } catch { return "other" }
    }

    @Test func aFreshIdPassesOnceAndThenIsUsed() {
        let t = tokens()
        let id = t.issue()
        #expect(reason { try PointsLookGate.check(actionId: id, tokens: t, secureInput: { false }, bundleId: safari, settings: settings) } == nil)
        #expect(reason { try PointsLookGate.check(actionId: id, tokens: t, secureInput: { false }, bundleId: safari, settings: settings) } == "action_used")
    }

    @Test func anIdTheHelperNeverIssuedIsRefused() {
        let t = tokens()
        _ = t.issue()
        for bad in ["", "act-99", "ACT-1", "act-1 ", "../act-1"] {
            #expect(reason { try PointsLookGate.check(actionId: bad, tokens: t, secureInput: { false }, bundleId: safari, settings: settings) } == "action_unknown", "\(bad)")
        }
    }

    @Test func aNewerIdReplacesTheOlderOne() {
        let t = tokens()
        let old = t.issue()
        let new = t.issue()
        #expect(reason { try PointsLookGate.check(actionId: old, tokens: t, secureInput: { false }, bundleId: safari, settings: settings) } == "action_used")
        #expect(reason { try PointsLookGate.check(actionId: new, tokens: t, secureInput: { false }, bundleId: safari, settings: settings) } == nil)
    }

    @Test func anOldIdLapses() {
        let clock = Clock()
        let t = tokens(clock)
        let id = t.issue()
        clock.now += PointsActionTokens.ttl + 1
        #expect(reason { try PointsLookGate.check(actionId: id, tokens: t, secureInput: { false }, bundleId: safari, settings: settings) } == "action_stale")
        // Positive control: the same id inside the window passes.
        let id2 = t.issue()
        clock.now += PointsActionTokens.ttl - 1
        #expect(reason { try PointsLookGate.check(actionId: id2, tokens: t, secureInput: { false }, bundleId: safari, settings: settings) } == nil)
    }

    @Test func secureEventInputRefusesAndAFreshIdIsSpentAnyway() {
        let t = tokens()
        let id = t.issue()
        #expect(reason { try PointsLookGate.check(actionId: id, tokens: t, secureInput: { true }, bundleId: safari, settings: settings) } == "secure_input")
        // The id is gone: a retry needs a new press.
        #expect(reason { try PointsLookGate.check(actionId: id, tokens: t, secureInput: { false }, bundleId: safari, settings: settings) } == "action_used")
    }

    @Test func everySection22AppIsRefusedAndABrowserIsNot() {
        let off = TierSettings(defaultValue: .interact, apps: ["com.example.offapp": .off])
        let rows = [
            "com.psyche.desktop", "com.apple.systempreferences", "com.1password.1password", "com.apple.Passwords", "com.bitwarden.desktop",
            "com.chase.mac", "com.robinhood.macos", "com.coinbase.Coinbase", "com.apple.Terminal", "com.apple.dt.Xcode", "com.example.offapp",
        ]
        for id in rows {
            let t = tokens()
            let a = t.issue()
            #expect(reason { try PointsLookGate.check(actionId: a, tokens: t, secureInput: { false }, bundleId: id, settings: off) } == "points_refused", "\(id)")
        }
        for id in ["com.apple.Safari", "com.google.Chrome", "com.apple.Preview"] {
            let t = tokens()
            let a = t.issue()
            #expect(reason { try PointsLookGate.check(actionId: a, tokens: t, secureInput: { false }, bundleId: id, settings: off) } == nil, "\(id)")
        }
    }

    @Test func theRefusalCarriesWhichRowItWas() throws {
        let t = tokens()
        let a = t.issue()
        do {
            try PointsLookGate.check(actionId: a, tokens: t, secureInput: { false }, bundleId: "com.1password.1password", settings: settings)
            Issue.record("expected a refusal")
        } catch let e as CapabilityError {
            #expect(e.details["refusal"] == .string("never_app"))
        }
    }
}

private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func next() -> Int { lock.withLock { n += 1; return n } }
}

@Suite("Points: look geometry and masks")
struct PointsLookGeometryTests {
    @Test func retinaAndNonRetinaPictureSizes() {
        // A 1000 x 600 pt window.
        let w = CGRect(x: 100, y: 50, width: 1000, height: 600)
        let one = PointsLookGeometry.imageSize(window: w, scale: 1)
        #expect(one.width == 1000 && one.height == 600, "non-Retina keeps its size, never enlarged")
        let two = PointsLookGeometry.imageSize(window: w, scale: 2)
        #expect(two.width <= PointsLookGeometry.maxWidth && two.height <= PointsLookGeometry.maxHeight)
        #expect(two.width == 1372 && abs(two.height - 823) <= 1, "Retina 2000 x 1200 is cut to the width budget with its aspect")
        // A tall window is cut by the height budget.
        let tall = PointsLookGeometry.imageSize(window: CGRect(x: 0, y: 0, width: 600, height: 1400), scale: 2)
        #expect(tall.height == 887)
        #expect(abs(Double(tall.width) / Double(tall.height) - 600.0 / 1400.0) < 0.01)
        #expect(PointsLookGeometry.imageSize(window: .zero, scale: 2) == (0, 0))
        #expect(PointsLookGeometry.imageSize(window: w, scale: 0) == (0, 0))
    }

    @Test func pointsPerPixelIsWindowOverImage() {
        let w = CGRect(x: 0, y: 0, width: 1000, height: 600)
        #expect(PointsLookGeometry.pointsPerPixel(window: w, imageWidth: 1000) == 1)
        #expect(abs(PointsLookGeometry.pointsPerPixel(window: w, imageWidth: 1372) - 1000.0 / 1372.0) < 1e-9)
        #expect(PointsLookGeometry.pointsPerPixel(window: w, imageWidth: 0) == 0)
    }

    @Test func aMaskCoversTheFieldWithPaddingOnNonRetina() {
        let w = CGRect(x: 100, y: 50, width: 400, height: 300)
        let field = CGRect(x: 150, y: 100, width: 100, height: 20)  // 50 pt in from the left, 50 down
        let rects = PointsLookGeometry.maskRects(frames: [field], window: w, imageSize: (400, 300), padding: 6)
        #expect(rects == [CGRect(x: 44, y: 44, width: 112, height: 32)])
    }

    @Test func aMaskScalesWithADownscaledRetinaPicture() {
        // 1000 x 600 pt window shown in a 1372 x 823 picture (Retina, cut to the budget).
        let w = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let field = CGRect(x: 500, y: 300, width: 100, height: 40)
        let r = PointsLookGeometry.maskRects(frames: [field], window: w, imageSize: (1372, 823), padding: 0)
        #expect(r.count == 1)
        let m = r[0]
        // The mask contains the scaled field, rounded outward.
        #expect(m.minX <= 500 * 1.372 && m.maxX >= 600 * 1.372)
        #expect(m.minY <= 300 * 823.0 / 600 && m.maxY >= 340 * 823.0 / 600)
        #expect(m.maxX - m.minX < 100 * 1.372 + 2)
    }

    @Test func aFrameHalfOutsideTheWindowIsCutAndOneWhollyOutsideIsDropped() {
        let w = CGRect(x: 0, y: 0, width: 200, height: 100)
        let r = PointsLookGeometry.maskRects(
            frames: [CGRect(x: 150, y: 80, width: 200, height: 100), CGRect(x: 500, y: 500, width: 10, height: 10), CGRect(x: -300, y: 0, width: 100, height: 10)],
            window: w, imageSize: (200, 100), padding: 0)
        #expect(r == [CGRect(x: 150, y: 80, width: 50, height: 20)])
    }

    @Test func aWindowAtANegativeOriginWorksLikeAnyOther() {
        // A window on a display to the left of and above the main one.
        let w = CGRect(x: -1500, y: -200, width: 800, height: 600)
        let r = PointsLookGeometry.maskRects(frames: [CGRect(x: -1400, y: -100, width: 100, height: 30)], window: w, imageSize: (800, 600), padding: 0)
        #expect(r == [CGRect(x: 100, y: 100, width: 100, height: 30)])
    }

    @Test func aFrameThatIsNotAFiniteRectangleMasksTheWholePicture() {
        let w = CGRect(x: 0, y: 0, width: 200, height: 100)
        let r = PointsLookGeometry.maskRects(frames: [CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10)], window: w, imageSize: (200, 100))
        #expect(r == [CGRect(x: 0, y: 0, width: 200, height: 100)])
        #expect(PointsLookGeometry.maskRects(frames: [CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 10)], window: w, imageSize: (200, 100)).count == 1)
    }

    @Test func noFramesNoMasks() {
        #expect(PointsLookGeometry.maskRects(frames: [], window: CGRect(x: 0, y: 0, width: 10, height: 10), imageSize: (10, 10)).isEmpty)
    }
}

@Suite("Points: box mapping")
struct PointsBoxMappingTests {
    private let one = [CGRect(x: 0, y: 0, width: 1440, height: 900)]

    @Test func mapsOnANonRetinaPicture() {
        let w = CGRect(x: 200, y: 100, width: 800, height: 600)
        let r = PointsBoxMapping.screenRect(box: CGRect(x: 100, y: 50, width: 200, height: 40), imageSize: CGSize(width: 800, height: 600), window: w, displays: one)
        #expect(r == CGRect(x: 300, y: 150, width: 200, height: 40))
    }

    @Test func mapsOnARetinaPictureCutToTheBudget() {
        // The same window captured at 2x and cut to 1372 wide: the answer is the same screen rectangle.
        let w = CGRect(x: 200, y: 100, width: 800, height: 600)
        let size = PointsLookGeometry.imageSize(window: w, scale: 2)
        #expect(size.width == 1183 && size.height == 887, "800 x 600 at 2x is 1600 x 1200, cut to fit 1372 x 887")
        let sx = CGFloat(size.width) / 800
        let sy = CGFloat(size.height) / 600
        let box = CGRect(x: 100 * sx, y: 50 * sy, width: 200 * sx, height: 40 * sy)
        let r = PointsBoxMapping.screenRect(box: box, imageSize: CGSize(width: size.width, height: size.height), window: w, displays: one)
        let want = CGRect(x: 300, y: 150, width: 200, height: 40)
        let got = try! #require(r)
        #expect(abs(got.minX - want.minX) < 0.01 && abs(got.minY - want.minY) < 0.01 && abs(got.width - want.width) < 0.01 && abs(got.height - want.height) < 0.01)
    }

    @Test func aBoxPastTheEdgeIsClampedToTheWindow() {
        let w = CGRect(x: 200, y: 100, width: 800, height: 600)
        let r = PointsBoxMapping.screenRect(box: CGRect(x: 700, y: 550, width: 400, height: 400), imageSize: CGSize(width: 800, height: 600), window: w, displays: one)
        #expect(r == CGRect(x: 900, y: 650, width: 100, height: 50))
        let neg = PointsBoxMapping.screenRect(box: CGRect(x: -50, y: -50, width: 100, height: 100), imageSize: CGSize(width: 800, height: 600), window: w, displays: one)
        #expect(neg == CGRect(x: 200, y: 100, width: 50, height: 50))
    }

    @Test func aBoxOutsideTheWindowIsRefused() {
        let w = CGRect(x: 200, y: 100, width: 800, height: 600)
        let img = CGSize(width: 800, height: 600)
        #expect(PointsBoxMapping.screenRect(box: CGRect(x: 900, y: 10, width: 50, height: 50), imageSize: img, window: w, displays: one) == nil)
        #expect(PointsBoxMapping.screenRect(box: CGRect(x: 10, y: 700, width: 50, height: 50), imageSize: img, window: w, displays: one) == nil)
    }

    @Test func malformedBoxesAndSizesAreRefused() {
        let w = CGRect(x: 0, y: 0, width: 800, height: 600)
        let img = CGSize(width: 800, height: 600)
        let bad: [CGRect] = [
            CGRect(x: 0, y: 0, width: 0, height: 10), CGRect(x: 0, y: 0, width: 10, height: -5), CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10),
            CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 10),
        ]
        for b in bad { #expect(PointsBoxMapping.screenRect(box: b, imageSize: img, window: w, displays: one) == nil, "\(b)") }
        let ok = CGRect(x: 10, y: 10, width: 10, height: 10)
        #expect(PointsBoxMapping.screenRect(box: ok, imageSize: .zero, window: w, displays: one) == nil)
        #expect(PointsBoxMapping.screenRect(box: ok, imageSize: CGSize(width: CGFloat.nan, height: 1), window: w, displays: one) == nil)
        #expect(PointsBoxMapping.screenRect(box: ok, imageSize: img, window: .zero, displays: one) == nil)
        // Positive control: the same box on a sane picture maps.
        #expect(PointsBoxMapping.screenRect(box: ok, imageSize: img, window: w, displays: one) != nil)
    }

    @Test func aWindowAcrossTwoDisplaysKeepsTheBoxOnTheDisplayThatHoldsMostOfIt() {
        // Main display 0..1440, a second display to its right. The window spans the seam at x = 1440.
        let displays = [CGRect(x: 0, y: 0, width: 1440, height: 900), CGRect(x: 1440, y: 0, width: 1920, height: 1080)]
        let w = CGRect(x: 1000, y: 100, width: 900, height: 600)
        let img = CGSize(width: 900, height: 600)
        // Box wholly on the second display.
        let right = PointsBoxMapping.screenRect(box: CGRect(x: 600, y: 100, width: 100, height: 50), imageSize: img, window: w, displays: displays)
        #expect(right == CGRect(x: 1600, y: 200, width: 100, height: 50))
        // Box across the seam: 30 pt left of it, 70 pt right: it is cut to the larger part.
        let seam = PointsBoxMapping.screenRect(box: CGRect(x: 410, y: 100, width: 100, height: 50), imageSize: img, window: w, displays: displays)
        #expect(seam == CGRect(x: 1440, y: 200, width: 70, height: 50))
        // Box wholly on the main display.
        let left = PointsBoxMapping.screenRect(box: CGRect(x: 10, y: 10, width: 100, height: 50), imageSize: img, window: w, displays: displays)
        #expect(left == CGRect(x: 1010, y: 110, width: 100, height: 50))
    }

    @Test func aDisplayLeftOfTheMainOneHasNegativeCoordinates() {
        let displays = [CGRect(x: 0, y: 0, width: 1440, height: 900), CGRect(x: -1920, y: -100, width: 1920, height: 1080)]
        let w = CGRect(x: -1800, y: 0, width: 800, height: 500)
        let r = PointsBoxMapping.screenRect(box: CGRect(x: 100, y: 100, width: 100, height: 40), imageSize: CGSize(width: 800, height: 500), window: w, displays: displays)
        #expect(r == CGRect(x: -1700, y: 100, width: 100, height: 40))
    }

    @Test func aWindowOffEveryDisplayHasNoSpot() {
        let displays = [CGRect(x: 0, y: 0, width: 1440, height: 900)]
        let w = CGRect(x: 3000, y: 0, width: 800, height: 500)
        #expect(PointsBoxMapping.screenRect(box: CGRect(x: 10, y: 10, width: 50, height: 50), imageSize: CGSize(width: 800, height: 500), window: w, displays: displays) == nil)
    }

    @Test func aBoxTouchingAPaintedFrameCountsAsSensitive() {
        let masks = [CGRect(x: 300, y: 300, width: 100, height: 20)]
        #expect(PointsBoxMapping.touchesAny(CGRect(x: 350, y: 305, width: 20, height: 10), in: masks))
        #expect(PointsBoxMapping.touchesAny(CGRect(x: 405, y: 300, width: 20, height: 10), in: masks), "inside the mask padding")
        #expect(!PointsBoxMapping.touchesAny(CGRect(x: 600, y: 600, width: 20, height: 10), in: masks))
        #expect(!PointsBoxMapping.touchesAny(CGRect(x: 350, y: 305, width: 20, height: 10), in: []))
        #expect(PointsBoxMapping.touchesAny(CGRect(x: 0, y: 0, width: 5, height: 5), in: [CGRect(x: CGFloat.nan, y: 0, width: 1, height: 1)]), "a broken frame fails closed")
    }

    @Test func aBoxOnADifferentPictureIsNotTheSameShape() {
        #expect(PointsBoxMapping.sameShape(CGSize(width: 1372, height: 823), CGSize(width: 1000, height: 600)))
        #expect(PointsBoxMapping.sameShape(CGSize(width: 686, height: 412), CGSize(width: 1372, height: 823)))
        #expect(!PointsBoxMapping.sameShape(CGSize(width: 1000, height: 1000), CGSize(width: 1372, height: 823)))
        #expect(!PointsBoxMapping.sameShape(.zero, CGSize(width: 10, height: 10)))
    }
}
