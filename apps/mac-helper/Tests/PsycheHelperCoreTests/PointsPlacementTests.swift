import CoreGraphics
import Foundation
import PsycheHelperCore
import Testing

@Suite("points overlay placement")
struct PointsPlacementTests {
    // A 1440x900 display with a 25 pt menu bar, as AX space sees it (top-left origin).
    static let main = PointsDisplay(frame: CGRect(x: 0, y: 0, width: 1440, height: 900), visible: CGRect(x: 0, y: 25, width: 1440, height: 875), scale: 2)
    static let size = CGSize(width: 300, height: 160)

    /// The card never overlaps the target or the next two fields, and stays on its display.
    private func expectClear(
        _ p: PointsCardPlacement, target: CGRect, next: [CGRect], displays: [PointsDisplay], _ note: String = "",
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        #expect(p.clear, "\(note) clear", sourceLocation: sourceLocation)
        #expect(!p.rect.intersects(target), "\(note) overlaps the target", sourceLocation: sourceLocation)
        for (i, n) in next.prefix(2).enumerated() {
            #expect(!p.rect.intersects(n), "\(note) overlaps next field \(i)", sourceLocation: sourceLocation)
        }
        let v = displays[p.displayIndex].visible
        #expect(v.contains(p.rect), "\(note) leaves the display: \(p.rect) vs \(v)", sourceLocation: sourceLocation)
    }

    // MARK: Where the card goes

    @Test func prefersTheWindowsRightMargin() {
        let window = CGRect(x: 100, y: 100, width: 800, height: 600)
        let target = CGRect(x: 300, y: 300, width: 300, height: 30)
        let next = [CGRect(x: 300, y: 360, width: 300, height: 30), CGRect(x: 300, y: 420, width: 300, height: 30)]
        let p = PointsGeometry.card(size: Self.size, target: target, next: next, window: window, displays: [Self.main])
        #expect(p.side == .windowRight)
        #expect(p.rect.minX >= window.maxX + PointsGeometry.gap - 0.5)
        expectClear(p, target: target, next: next, displays: [Self.main])
    }

    @Test func usesTheLeftMarginWhenTheRightOneIsTooNarrow() {
        let window = CGRect(x: 420, y: 100, width: 900, height: 600)  // 120 pt of room on the right, 420 on the left
        let target = CGRect(x: 600, y: 300, width: 300, height: 30)
        let p = PointsGeometry.card(size: Self.size, target: target, next: [], window: window, displays: [Self.main])
        #expect(p.side == .windowLeft)
        #expect(p.rect.maxX <= window.minX)
        expectClear(p, target: target, next: [], displays: [Self.main])
    }

    @Test func fallsBackToTheDisplayEdgeWhenTheWindowFillsTheScreen() {
        let window = CGRect(x: 0, y: 25, width: 1440, height: 875)
        let target = CGRect(x: 100, y: 300, width: 300, height: 30)
        let p = PointsGeometry.card(size: Self.size, target: target, next: [], window: window, displays: [Self.main])
        #expect(p.side == .displayRight)
        expectClear(p, target: target, next: [], displays: [Self.main])
    }

    @Test func slidesOffAFieldThatSitsInItsColumn() {
        // The window fills the screen and the field is under the display-right column.
        let window = CGRect(x: 0, y: 25, width: 1440, height: 875)
        let target = CGRect(x: 1100, y: 300, width: 300, height: 30)
        let next = [CGRect(x: 1100, y: 350, width: 300, height: 30), CGRect(x: 1100, y: 400, width: 300, height: 30)]
        let p = PointsGeometry.card(size: Self.size, target: target, next: next, window: window, displays: [Self.main])
        expectClear(p, target: target, next: next, displays: [Self.main])
    }

    @Test func staysOffTheNextTwoPlannedFieldsButMayOverlapThirdOne() {
        let window = CGRect(x: 0, y: 25, width: 1440, height: 875)
        let target = CGRect(x: 1100, y: 100, width: 300, height: 30)
        let next = [CGRect(x: 1100, y: 140, width: 300, height: 30), CGRect(x: 1100, y: 180, width: 300, height: 30), CGRect(x: 1100, y: 220, width: 300, height: 30)]
        let p = PointsGeometry.card(size: Self.size, target: target, next: next, window: window, displays: [Self.main])
        #expect(!p.rect.intersects(target))
        #expect(!p.rect.intersects(next[0]))
        #expect(!p.rect.intersects(next[1]))
    }

    @Test func aFieldInTheCornerStillGetsACardInsideTheVisibleArea() {
        for target in [
            CGRect(x: 0, y: 25, width: 200, height: 24), CGRect(x: 1240, y: 25, width: 200, height: 24),
            CGRect(x: 0, y: 876, width: 200, height: 24), CGRect(x: 1240, y: 876, width: 200, height: 24),
        ] {
            let p = PointsGeometry.card(size: Self.size, target: target, next: [], window: nil, displays: [Self.main])
            expectClear(p, target: target, next: [], displays: [Self.main], "\(target)")
        }
    }

    @Test func aFieldThatFillsTheScreenGetsTheLeastBadSpotAndIsReportedNotClear() {
        let target = Self.main.visible
        let p = PointsGeometry.card(size: Self.size, target: target, next: [], window: nil, displays: [Self.main])
        #expect(!p.clear)
        #expect(p.side == .forced)
        #expect(Self.main.visible.contains(p.rect))
    }

    @Test func aCardTallerThanTheDisplayIsCutToIt() {
        let small = PointsDisplay(frame: CGRect(x: 0, y: 0, width: 200, height: 100))
        let p = PointsGeometry.card(size: Self.size, target: CGRect(x: 10, y: 10, width: 20, height: 10), next: [], window: nil, displays: [small])
        #expect(small.visible.contains(p.rect))
    }

    // MARK: Sweep

    /// A deterministic spread of fields on two displays: whenever a free spot exists, the card is on it.
    @Test func neverOverlapsTheTargetOrTheNextTwoFieldsAcrossASweep() {
        let right = PointsDisplay(frame: CGRect(x: 1440, y: 0, width: 1920, height: 1080), visible: CGRect(x: 1440, y: 0, width: 1920, height: 1055), scale: 1)
        let displays = [Self.main, right]
        var seed: UInt64 = 0x2545F4914F6CDD1D
        func rnd(_ n: Int) -> CGFloat {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return CGFloat((seed >> 33) % UInt64(n))
        }
        var checked = 0
        for _ in 0..<600 {
            let onRight = rnd(2) == 1
            let d = displays[onRight ? 1 : 0]
            let w = 120 + rnd(500)
            let h = 22 + rnd(80)
            let x = d.frame.minX + rnd(Int(d.frame.width - w))
            let y = d.frame.minY + rnd(Int(d.frame.height - h))
            let target = CGRect(x: x, y: y, width: w, height: h)
            let next = [
                CGRect(x: x, y: y + h + 8, width: w, height: h),
                CGRect(x: x + (rnd(2) == 1 ? w + 8 : 0), y: y + 2 * (h + 8), width: w, height: h),
            ]
            let window = CGRect(x: d.frame.minX + rnd(200), y: d.frame.minY + 40, width: 400 + rnd(700), height: 500 + rnd(300))
            let p = PointsGeometry.card(size: Self.size, target: target, next: next, window: window, displays: displays)
            expectClear(p, target: target, next: next, displays: displays, "\(target)")
            checked += 1
        }
        #expect(checked == 600)
    }

    // MARK: Displays

    @Test func theCardGoesOnTheDisplayThatHoldsTheField() {
        let right = PointsDisplay(frame: CGRect(x: 1440, y: 0, width: 1920, height: 1080), scale: 1)
        let target = CGRect(x: 2000, y: 400, width: 300, height: 30)
        // The window spans both displays.
        let window = CGRect(x: 1000, y: 100, width: 1800, height: 700)
        let p = PointsGeometry.card(size: Self.size, target: target, next: [], window: window, displays: [Self.main, right])
        #expect(p.displayIndex == 1)
        #expect(right.visible.contains(p.rect))
        #expect(PointsGeometry.displaysTouching(window, displays: [Self.main, right]) == [0, 1])
        #expect(PointsGeometry.displaysTouching(target, displays: [Self.main, right]) == [1])
    }

    @Test func aFieldAcrossTheSeamGetsAPointerLayerOnEachDisplay() {
        let right = PointsDisplay(frame: CGRect(x: 1440, y: 0, width: 1920, height: 1080), scale: 1)
        let target = CGRect(x: 1200, y: 400, width: 300, height: 30)
        let ring = PointsGeometry.ringRect(for: target)
        #expect(PointsGeometry.displaysTouching(ring, displays: [Self.main, right]) == [0, 1])
        // The card is on the display with most of the field.
        #expect(PointsGeometry.displayIndex(for: target, displays: [Self.main, right]) == 0)
    }

    @Test func aDisplayAbovePrimaryHasNegativeAXY() {
        let above = PointsDisplay(frame: CGRect(x: 0, y: -1080, width: 1920, height: 1080), scale: 1)
        let target = CGRect(x: 400, y: -600, width: 300, height: 30)
        let p = PointsGeometry.card(size: Self.size, target: target, next: [], window: nil, displays: [Self.main, above])
        #expect(p.displayIndex == 1)
        expectClear(p, target: target, next: [], displays: [Self.main, above])
    }

    @Test func aRectInAGapBelongsToTheNearestDisplay() {
        let right = PointsDisplay(frame: CGRect(x: 1600, y: 0, width: 800, height: 600), scale: 1)
        #expect(PointsGeometry.displayIndex(for: CGRect(x: 1560, y: 100, width: 20, height: 20), displays: [Self.main, right]) == 1)
        #expect(PointsGeometry.displayIndex(for: CGRect(x: 1450, y: 100, width: 20, height: 20), displays: [Self.main, right]) == 0)
    }

    // MARK: Retina

    @Test func aRetinaCardSitsOnTheHalfPixelGridAndStillAvoidsTheField() {
        let target = CGRect(x: 300.25, y: 300.75, width: 301.5, height: 30.5)
        let next = [CGRect(x: 300.25, y: 340.25, width: 301.5, height: 30.5)]
        let p = PointsGeometry.card(size: Self.size, target: target, next: next, window: CGRect(x: 100.3, y: 100.3, width: 800.4, height: 600.1), displays: [Self.main])
        #expect((p.rect.minX * 2).rounded() == p.rect.minX * 2)
        #expect((p.rect.minY * 2).rounded() == p.rect.minY * 2)
        expectClear(p, target: target, next: next, displays: [Self.main])
    }

    @Test func snapRoundsToThePixelGridOfTheDisplay() {
        let r = PointsGeometry.snap(CGRect(x: 10.3, y: 20.8, width: 300, height: 160), scale: 2)
        #expect(r.minX == 10.5 && r.minY == 21 && r.width == 300)
        let one = PointsGeometry.snap(CGRect(x: 10.3, y: 20.8, width: 300, height: 160), scale: 1)
        #expect(one.minX == 10 && one.minY == 21)
    }

    // MARK: Ring and chevron

    @Test func theRingIsFourPointsOutsideTheFieldAndFiveWithIncreasedContrast() {
        let f = CGRect(x: 100, y: 100, width: 200, height: 30)
        #expect(PointsGeometry.ringRect(for: f) == CGRect(x: 96, y: 96, width: 208, height: 38))
        #expect(PointsGeometry.ringWidth(increasedContrast: false) == 3)
        #expect(PointsGeometry.ringWidth(increasedContrast: true) == 5)
    }

    @Test func aFieldScrolledOutOfTheWindowGetsAnEdgeChevron() {
        let w = CGRect(x: 100, y: 100, width: 800, height: 600)
        #expect(PointsGeometry.offscreenEdge(target: CGRect(x: 200, y: 750, width: 100, height: 30), window: w) == .below)
        #expect(PointsGeometry.offscreenEdge(target: CGRect(x: 200, y: 20, width: 100, height: 30), window: w) == .above)
        #expect(PointsGeometry.offscreenEdge(target: CGRect(x: 920, y: 300, width: 100, height: 30), window: w) == .right)
        #expect(PointsGeometry.offscreenEdge(target: CGRect(x: 0, y: 300, width: 50, height: 30), window: w) == .left)
        // Vertical wins on a diagonal.
        #expect(PointsGeometry.offscreenEdge(target: CGRect(x: 920, y: 750, width: 50, height: 30), window: w) == .below)
        // Positive controls: partly or fully inside is not off screen.
        #expect(PointsGeometry.offscreenEdge(target: CGRect(x: 200, y: 690, width: 100, height: 30), window: w) == nil)
        #expect(PointsGeometry.offscreenEdge(target: CGRect(x: 200, y: 300, width: 100, height: 30), window: w) == nil)
    }

    // MARK: Coordinates

    @Test func axAndAppKitCoordinatesRoundTrip() {
        let ax = CGRect(x: 120, y: 80, width: 300, height: 160)
        let appKit = PointsGeometry.appKitRect(fromAX: ax, primaryHeight: 900)
        #expect(appKit == CGRect(x: 120, y: 660, width: 300, height: 160))
        #expect(PointsGeometry.axRect(fromAppKit: appKit, primaryHeight: 900) == ax)
        // A display above the primary one has negative AX y and AppKit y above the primary height.
        let up = PointsGeometry.appKitRect(fromAX: CGRect(x: 0, y: -1080, width: 1920, height: 1080), primaryHeight: 900)
        #expect(up.minY == 900)
        #expect(PointsGeometry.axRect(fromAppKit: up, primaryHeight: 900).minY == -1080)
    }

    @Test func theWindowListMatchesTheAXWindowWithinAFewPoints() {
        let ax = CGRect(x: 100, y: 100, width: 800, height: 600)
        #expect(PointsGeometry.sameWindow(ax, CGRect(x: 101, y: 99, width: 800, height: 601)))
        #expect(!PointsGeometry.sameWindow(ax, CGRect(x: 110, y: 100, width: 800, height: 600)))
        #expect(!PointsGeometry.sameWindow(ax, CGRect(x: 100, y: 100, width: 700, height: 600)))
    }

    // MARK: Dimming

    @Test func theCardDimsWhileTypingAndComesBackOneSecondAfterTheLastChange() {
        var d = PointsDimmer()
        #expect(!d.isDimmed(at: 0))
        d.valueChanged(at: 10)
        #expect(d.isDimmed(at: 10))
        #expect(d.isDimmed(at: 10.9))
        #expect(!d.isDimmed(at: 11))
        #expect(PointsDimmer.dimmedAlpha == 0.4)
        // Another change moves the deadline.
        d.valueChanged(at: 10.8)
        #expect(d.isDimmed(at: 11.5))
        #expect(d.restoreTime(at: 11.5) == 11.8)
        #expect(!d.isDimmed(at: 11.8))
        #expect(d.restoreTime(at: 12) == nil)
        d.valueChanged(at: 20)
        d.reset()
        #expect(!d.isDimmed(at: 20.1))
    }

    // MARK: Esc

    @Test func onlyABareEscapeStops() {
        #expect(PointsKeys.isBareEscape(keyCode: 53, modifierBits: 0))
        // Caps Lock and the numeric-pad / Fn bits are not modifiers.
        #expect(PointsKeys.isBareEscape(keyCode: 53, modifierBits: 1 << 16))
        #expect(PointsKeys.isBareEscape(keyCode: 53, modifierBits: 1 << 21))
        for bit: UInt64 in [17, 18, 19, 20] { #expect(!PointsKeys.isBareEscape(keyCode: 53, modifierBits: 1 << bit), "bit \(bit)") }
        for code: UInt16 in [0, 36, 48, 51, 52, 54] { #expect(!PointsKeys.isBareEscape(keyCode: code, modifierBits: 0), "key \(code)") }
    }

    // MARK: Card text

    @Test func placeholdersAreFilledInOnePass() {
        #expect(PointsCardText.fill("{n}/{total}", n: 2, total: 5) == "2/5")
        #expect(PointsCardText.fill("◉ Pointing: {app}", app: "Safari") == "◉ Pointing: Safari")
        #expect(PointsCardText.fill("Scroll down to {label}", label: "Email") == "Scroll down to Email")
        // A value that looks like a placeholder is not expanded again.
        #expect(PointsCardText.fill("You fill this yourself: {label}", label: "{app}", app: "Safari") == "You fill this yourself: {app}")
        // Unknown and unfilled placeholders stay as written; stray braces survive.
        #expect(PointsCardText.fill("{x} {label} } {", label: nil) == "{x} {label} } {")
        #expect(PointsCardText.fill("{label}{label}", label: "A") == "AA")
        #expect(PointsCardText.fill("", label: "A") == "")
        #expect(PointsCardText.fill("日本語 {label}", label: "名前") == "日本語 名前")
    }

    @Test func cardTextDropsControlAndBidiCharactersAndIsClamped() {
        #expect(PointsCardText.clean("Hello\u{202E}dlrow", max: 100) == "Hellodlrow")
        #expect(PointsCardText.clean("a\u{0007}b\u{200B}c\u{2066}d\u{2069}", max: 100) == "abcd")
        #expect(PointsCardText.clean("one\ntwo\r\n\tthree", max: 100) == "one two three")
        #expect(PointsCardText.clean("  spaced   out  ", max: 100) == "spaced out")
        #expect(PointsCardText.clean("a\u{2028}b\u{2029}c\u{0085}d", max: 100) == "abcd")
        #expect(PointsCardText.clean(String(repeating: "x", count: 500), max: 300).count == 300)
        #expect(PointsCardText.clean("👨‍👩‍👧x", max: 1) == "👨‍👩‍👧")
        // Positive control: ordinary text, including other scripts, passes unchanged.
        #expect(PointsCardText.clean("Ada Lovelace, 12 Main St. Привет 日本", max: 100) == "Ada Lovelace, 12 Main St. Привет 日本")
    }
}
