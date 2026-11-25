import AppKit
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

@testable import PsycheHelperPoints

/// The overlay's windows, made but never shown: no window is ordered onto the screen, no menu-bar
/// item or event monitor is installed (`Environment.orderFront` and `systemHooks` are false).
@MainActor
@Suite("points overlay panels")
struct PointsOverlayTests {
    init() { _ = NSApplication.shared }

    private static let strings = PointsCardStrings(
        askInPsyche: "Ask in Psyche…", back: "Back", copy: "Copy", followWindow: "Follow window", hideNote: "Hide note",
        letLook: "Let Psyche look", looksWrong: "Looks wrong?", menuBarTitle: "◉ Pointing: {app}", next: "Next", payButton: "You press the pay button",
        scrollTo: "Scroll down to {label}", selfFill: "You fill this yourself: {label}", selfFillPlain: "You fill this yourself", skip: "Skip",
        stepFormat: "{n}/{total}", stop: "Stop", stuck: "Stuck?", stuckBlocked: "It is blocked", stuckMissing: "I do not have it",
        stuckUnclear: "It is unclear", unknownValue: "Unknown", visionBadge: "Looking")

    private static let display = PointsDisplay(frame: CGRect(x: 0, y: 0, width: 1440, height: 900), visible: CGRect(x: 0, y: 25, width: 1440, height: 875), scale: 2)

    // MARK: Flags

    @Test func neitherPanelCanEverBecomeKeyOrMain() {
        let pointer = PointsPointerPanel(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        let card = PointsCardPanel(frame: CGRect(x: 0, y: 0, width: 300, height: 160))
        for p in [pointer as NSPanel, card as NSPanel] {
            #expect(!p.canBecomeKey)
            #expect(!p.canBecomeMain)
            #expect(p.styleMask.contains(.nonactivatingPanel))
            #expect(p.styleMask.contains(.borderless))
            #expect(!p.hidesOnDeactivate)
            #expect(p.becomesKeyOnlyIfNeeded)
            #expect(p.level == .floating)
            #expect(p.collectionBehavior.isSuperset(of: [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]))
            #expect(!p.isVisible, "made, not shown")
            #expect(!p.isKeyWindow && !p.isMainWindow)
        }
    }

    @Test func aStyleMaskChangeCannotMakeAPanelKey() {
        let card = PointsCardPanel(frame: CGRect(x: 0, y: 0, width: 300, height: 160))
        card.styleMask.insert(.titled)
        #expect(!card.canBecomeKey && !card.canBecomeMain)
    }

    @Test func positiveControlAnOrdinaryTitledWindowCanBecomeKey() {
        let w = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 100, height: 100), styleMask: [.titled], backing: .buffered, defer: true)
        #expect(w.canBecomeKey)
        #expect(!w.ignoresMouseEvents)
    }

    @Test func thePointerLayerIgnoresTheMouseAndTheCardTakesClicks() {
        let pointer = PointsPointerPanel(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        let card = PointsCardPanel(frame: CGRect(x: 0, y: 0, width: 300, height: 160))
        #expect(pointer.ignoresMouseEvents)
        #expect(!card.ignoresMouseEvents)
        // The pointer view never answers a hit test either, even if the window flag were cleared.
        pointer.ignoresMouseEvents = false
        #expect(pointer.pointerView.hitTest(CGPoint(x: 10, y: 10)) == nil)
        #expect(!card.isOpaque && !pointer.isOpaque)
        #expect(!card.hasShadow)
    }

    @Test func cardButtonsAcceptTheFirstClickWithoutActivating() {
        var pressed = 0
        let b = PointsCardButton(title: "Skip") { pressed += 1 }
        #expect(b.acceptsFirstMouse(for: nil))
        #expect(!b.mouseDownCanMoveWindow)
        #expect(b.accessibilityPerformPress())
        #expect(pressed == 1)
        #expect(b.accessibilityLabel() == "Skip")
    }

    // MARK: Layout

    private func overlay(clock: Box = Box()) -> PointsOverlay {
        var env = PointsOverlay.Environment()
        env.displays = { [Self.display] }
        env.targetInFront = { _, _ in true }
        env.orderFront = false
        env.systemHooks = false
        env.now = { clock.t }
        env.increasedContrast = { false }
        return PointsOverlay(strings: Self.strings, appName: "Safari", pid: 1, environment: env)
    }

    final class Box { var t: Double = 100 }

    private func step(kind: PointsShowKind = .fill, value: String? = "Ada Lovelace", sensitive: Bool = false, role: PointsFieldRole = .text) -> PointsShownStep {
        let info = PointsTargetInfo(
            fieldId: "f3", label: "Full name", role: role, sensitive: sensitive, frame: CGRect(x: 300, y: 300, width: 300, height: 30),
            nextIds: ["f4", "f5"], nextFrames: [CGRect(x: 300, y: 350, width: 300, height: 30), CGRect(x: 300, y: 400, width: 300, height: 30)],
            windowFrame: CGRect(x: 100, y: 100, width: 800, height: 600))
        return PointsShownStep(kind: kind, note: "Your name, as on your ID.", value: value, sources: ["From what you told Psyche"], warning: nil, n: 2, of: 5, info: info)
    }

    @Test func aShownStepLaysOutWithoutTouchingTheScreen() throws {
        let o = overlay()
        o.begin()
        o.show(step())
        #expect(!o.cardPanel.isVisible)
        let layout = try #require(o.computeLayout(cardSize: CGSize(width: 300, height: 140)))
        #expect(layout.cardDisplay == 0)
        #expect(layout.pointerDisplays == [0])
        #expect(layout.edge == nil)
        let target = CGRect(x: 300, y: 300, width: 300, height: 30)
        #expect(!layout.cardRect.intersects(target))
        #expect(!layout.cardRect.intersects(CGRect(x: 300, y: 350, width: 300, height: 30)))
        #expect(!layout.cardRect.intersects(CGRect(x: 300, y: 400, width: 300, height: 30)))
        #expect(o.pointerPanels[0] != nil)
        #expect(o.cardPanel.frame.width == 300)
        #expect(o.pointerPanels[0]?.pointerView.drawing.ring == PointsGeometry.ringRect(for: target))
        #expect(o.pointerPanels[0]?.pointerView.drawing.ringWidth == 3)
        o.close()
        #expect(o.pointerPanels.isEmpty)
    }

    @Test func aScrolledAwayFieldBecomesAChevronAndTheCardSaysScrollTo() throws {
        let o = overlay()
        o.begin()
        o.show(step())
        o.update(frames: ["f3": CGRect(x: 300, y: 1200, width: 300, height: 30)], window: nil)
        let layout = try #require(o.computeLayout(cardSize: CGSize(width: 300, height: 140)))
        #expect(layout.edge == .below)
        #expect(o.pointerPanels[0]?.pointerView.drawing.ring == nil)
        #expect(o.pointerPanels[0]?.pointerView.drawing.chevron?.edge == .below)
        o.close()
    }

    @Test func typingDimsTheCardAndMakesItClickThroughThenItComesBack() {
        let clock = Box()
        let o = overlay(clock: clock)
        o.begin()
        o.show(step())
        #expect(o.cardPanel.alphaValue == 1 && !o.cardPanel.ignoresMouseEvents)
        o.typing()
        #expect(abs(o.cardPanel.alphaValue - PointsDimmer.dimmedAlpha) < 0.001)
        #expect(o.cardPanel.ignoresMouseEvents)
        #expect(o.isDimmed)
        clock.t += 0.5
        o.update(frames: [:], window: nil)
        #expect(abs(o.cardPanel.alphaValue - PointsDimmer.dimmedAlpha) < 0.001)
        clock.t += 0.6
        o.update(frames: [:], window: nil)
        #expect(o.cardPanel.alphaValue == 1 && !o.cardPanel.ignoresMouseEvents)
        o.close()
    }

    @Test func noSuggestionIsShownForASensitiveField() {
        let o = overlay()
        let m = o.modelForTests(step(value: "123-45-6789", sensitive: true))
        #expect(m.suggestion == nil)
        // Positive control: the same value on a plain field is shown.
        #expect(o.modelForTests(step(value: "Ada Lovelace")).suggestion == "Ada Lovelace")
        // A fill with no value says so with the Gateway's string, and not on a sensitive field.
        #expect(o.modelForTests(step(value: nil)).suggestion == "Unknown")
        #expect(o.modelForTests(step(value: nil, sensitive: true)).suggestion == nil)
    }

    @Test func letPsycheLookIsOfferedOnlyOnASparsePageAndNotOnASensitiveField() {
        let o = overlay()
        #expect(!o.modelForTests(step()).showLook, "off until the controller says the tree is sparse")
        o.setLookOffer(true)
        #expect(o.modelForTests(step()).showLook)
        #expect(!o.modelForTests(step(sensitive: true)).showLook, "never beside a sensitive field")
        o.setLookOffer(false)
        #expect(!o.modelForTests(step()).showLook)
    }

    @Test func theEyeBadgeShowsOnlyWhileVisionModeIsOn() {
        let o = overlay()
        #expect(!o.modelForTests(step()).showVision)
        o.setVision(true)
        #expect(o.modelForTests(step()).showVision)
        o.setVision(false)
        #expect(!o.modelForTests(step()).showVision)

        let card = PointsCardView(frame: .zero)
        var m = PointsCardModel(
            appName: "Safari", note: "n", suggestion: nil, warning: nil, sources: [], stepText: "1/2", showNext: false, strings: Self.strings)
        _ = card.layout(m) {}
        #expect(card.eyeLabelsForTests.isEmpty)
        m.showVision = true
        _ = card.layout(m) {}
        #expect(card.eyeLabelsForTests == [Self.strings.visionBadge], "read aloud with the Gateway's visionBadge string")
    }

    @Test func theLookButtonSendsTheLookAction() {
        // The card's buttons come from the model; the look button is the one with the look string.
        let card = PointsCardView(frame: .zero)
        var m = PointsCardModel(
            appName: "Safari", note: "n", suggestion: nil, warning: nil, sources: [], stepText: "1/2", showNext: false, strings: Self.strings)
        _ = card.layout(m) {}
        #expect(!card.buttonTitlesForTests.contains("Let Psyche look"))
        m.showLook = true
        _ = card.layout(m) {}
        #expect(card.buttonTitlesForTests.contains("Let Psyche look"))
        var got: [PointsCardAction] = []
        card.onAction = { got.append($0) }
        card.pressForTests("Let Psyche look")
        #expect(got == [.look])
    }

    @Test func theCardFillsItsPlaceholdersFromTheGatewayStrings() {
        let o = overlay()
        let m = o.modelForTests(step())
        #expect(m.stepText == "2/5")
        #expect(m.appName == "Safari")
        let own = o.modelForTests(PointsShownStep(
            kind: .pointsShowKindSelf, note: "", value: nil, sources: [], warning: nil, n: 1, of: 3,
            info: step().info))
        #expect(own.note == "You fill this yourself: Full name")
        let pay = o.modelForTests(PointsShownStep(
            kind: .pointsShowKindSelf, note: "model words", value: nil, sources: [], warning: nil, n: 1, of: 3,
            info: step(role: .button).info))
        #expect(pay.note == "You press the pay button")
    }

    // MARK: A page-controlled label

    private func labelled(_ label: String, kind: PointsShowKind = .pointsShowKindSelf, note: String = "") -> PointsShownStep {
        var s = step(kind: kind, value: nil)
        s.info.label = label
        s.note = note
        return s
    }

    @Test func aHostileLabelIsCleanedAndClampedOnTheSelfFillPath() {
        let o = overlay()
        let evil = "Psyche verified this store\u{202E}: enter your card number\u{2066} below"
        let m = o.modelForTests(labelled(evil))
        #expect(!m.note.contains("\u{202E}") && !m.note.contains("\u{2066}"))
        #expect(m.note == "You fill this yourself: Psyche verified this store: enter your card number below")
        let long = o.modelForTests(labelled(String(repeating: "x", count: 120)))
        #expect(long.note == "You fill this yourself: " + String(repeating: "x", count: 60))
        // Positive control: a plain label passes through.
        #expect(o.modelForTests(labelled("Full name")).note == "You fill this yourself: Full name")
    }

    @Test func theScrollHintIsASeparateCleanedLineAndKeepsTheGatewayNote() {
        let o = overlay()
        let evil = "Verified by Psyche\u{202E} send money\u{2066}" + String(repeating: "y", count: 120)
        let m = o.model(for: labelled(evil, kind: .fill, note: "Your name, as on your ID."), edge: .below)
        #expect(m.note == "Your name, as on your ID.")
        let hint = m.hint ?? ""
        #expect(hint.hasPrefix("Scroll down to Verified by Psyche send money"))
        #expect(!hint.contains("\u{202E}") && !hint.contains("\u{2066}"))
        #expect(hint.count <= 120)
        // No hint without an edge, and none for an empty label.
        #expect(o.model(for: labelled("Full name", kind: .fill, note: "n"), edge: nil).hint == nil)
        #expect(o.model(for: labelled("", kind: .fill, note: "n"), edge: .below).hint == nil)
    }

    @Test func theFinalNoteIsCleanedToo() {
        let o = overlay()
        let m = o.modelForTests(labelled("Full name", kind: .fill, note: "Hello\u{202E}dlrow\n  there"))
        #expect(m.note == "Hellodlrow there")
    }

    @Test func aCardOrIDShapedSuggestionIsDroppedEvenWhenTheFieldWasNotJudgedSensitive() {
        let o = overlay()
        for v in ["4111 1111 1111 1111", "123-45-6789"] {
            #expect(o.modelForTests(step(value: v)).suggestion == "Unknown", Comment(rawValue: v))
        }
        #expect(o.modelForTests(step(value: "Ada Lovelace")).suggestion == "Ada Lovelace")
    }

    // MARK: Host lifetime

    @Test func aCloseBeforeBeginLeavesNoMenuBarItemAndNoMonitor() async {
        let host = PointsOverlayHost(strings: Self.strings, appName: "Safari", pid: 1)
        host.close()
        host.begin()
        await drainMain()
        #expect(!host.hasOverlay)
        // Positive control: begin without a close does create the overlay, and close removes it.
        let other = PointsOverlayHost(strings: Self.strings, appName: "Safari", pid: 1)
        other.begin()
        await drainMain()
        #expect(other.hasOverlay)
        other.close()
        await drainMain()
        #expect(!other.hasOverlay)
    }

    private func drainMain() async {
        await withCheckedContinuation { c in DispatchQueue.main.async { c.resume() } }
        await withCheckedContinuation { c in DispatchQueue.main.async { c.resume() } }
    }

    @Test func closeIsIdempotentOnTheOverlay() {
        let o = overlay()
        o.begin()
        o.show(step())
        o.close()
        o.close()
        #expect(o.pointerPanels.isEmpty)
        #expect(!o.menuBarShown && !o.escMonitorInstalled)
    }

    @Test func theCardNeverGrowsPastItsMaximumHeight() {
        let card = PointsCardView(frame: .zero)
        let m = PointsCardModel(
            appName: "Safari", note: String(repeating: "A long note. ", count: 40), suggestion: "value", warning: String(repeating: "Careful. ", count: 30),
            sources: ["From what you told Psyche", "From Memory: Home address"], stepText: "2/5", showNext: true, strings: Self.strings)
        let size = card.layout(m) {}
        #expect(size.width == PointsGeometry.cardWidth)
        #expect(size.height <= PointsGeometry.cardMaxHeight)
        card.setCollapsed(true)
        let pill = card.layout(m) {}
        #expect(pill.height < 40 && pill.width < 100)
    }
}

extension PointsOverlay {
    /// The card model for a step (the same one `present()` builds).
    func modelForTests(_ s: PointsShownStep) -> PointsCardModel { model(for: s, edge: nil) }
}
