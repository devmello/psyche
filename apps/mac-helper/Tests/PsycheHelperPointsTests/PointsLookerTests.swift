import CoreGraphics
import Foundation
import PsycheCapture
import PsycheHelperCore
import PsycheProtocol
import Testing

@testable import PsycheHelperPoints

/// Fixture frames and a fake environment: no Screen Recording, no ScreenCaptureKit, no keyboard state.
private enum Fixture {
    /// A solid white RGBA picture.
    static func white(_ w: Int, _ h: Int) -> CGImage {
        let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()!
    }

    /// The RGB of the pixel at (x, y), the origin at the TOP-left.
    static func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (UInt8, UInt8, UInt8) {
        var data = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let ctx = CGContext(
            data: &data, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let i = (y * image.width + x) * 4
        return (data[i], data[i + 1], data[i + 2])
    }

    static func isBlack(_ p: (UInt8, UInt8, UInt8)) -> Bool { p.0 == 0 && p.1 == 0 && p.2 == 0 }
    static func isWhite(_ p: (UInt8, UInt8, UInt8)) -> Bool { p.0 == 255 && p.1 == 255 && p.2 == 255 }
}

@Suite("Points: image mask")
struct ImageMaskTests {
    @Test func paintsTheGivenRectanglesAndNothingElse() throws {
        let img = Fixture.white(100, 60)
        let out = try #require(ImageMask.paint(img, rects: [CGRect(x: 10, y: 5, width: 30, height: 10)]))
        #expect(out.width == 100 && out.height == 60)
        // Inside, including the corners.
        for (x, y) in [(10, 5), (39, 5), (10, 14), (39, 14), (25, 10)] { #expect(Fixture.isBlack(Fixture.pixel(out, x, y)), "(\(x), \(y)) should be painted") }
        // Just outside, on each side, and far away.
        for (x, y) in [(9, 10), (40, 10), (25, 4), (25, 15), (80, 50), (0, 0)] { #expect(Fixture.isWhite(Fixture.pixel(out, x, y)), "(\(x), \(y)) should be untouched") }
    }

    @Test func theOriginIsTheTopLeftNotTheBottomLeft() throws {
        let out = try #require(ImageMask.paint(Fixture.white(40, 40), rects: [CGRect(x: 0, y: 0, width: 40, height: 5)]))
        #expect(Fixture.isBlack(Fixture.pixel(out, 20, 2)))
        #expect(Fixture.isWhite(Fixture.pixel(out, 20, 37)))
    }

    @Test func control_noRectanglesLeavesThePictureWhite() throws {
        let out = try #require(ImageMask.paint(Fixture.white(30, 30), rects: []))
        for (x, y) in [(0, 0), (15, 15), (29, 29)] { #expect(Fixture.isWhite(Fixture.pixel(out, x, y))) }
    }

    @Test func aRectangleHangingOffTheImageIsCut() throws {
        let out = try #require(ImageMask.paint(Fixture.white(20, 20), rects: [CGRect(x: 15, y: 15, width: 100, height: 100)]))
        #expect(Fixture.isBlack(Fixture.pixel(out, 19, 19)))
        #expect(Fixture.isWhite(Fixture.pixel(out, 14, 14)))
    }

    @Test func aBrokenRectangleFailsInsteadOfLeavingAGap() {
        #expect(ImageMask.paint(Fixture.white(20, 20), rects: [CGRect(x: CGFloat.nan, y: 0, width: 5, height: 5)]) == nil)
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.withLock { n += 1 } }
    var value: Int { lock.withLock { n } }
}

private final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T {
        get { lock.withLock { v } }
        set { lock.withLock { v = newValue } }
    }
}

@Suite("points.look")
struct PointsLookerTests {
    private let window = CGRect(x: 100, y: 50, width: 400, height: 300)
    private let password = CGRect(x: 150, y: 100, width: 100, height: 20)
    private let card = CGRect(x: 150, y: 200, width: 120, height: 20)

    private struct Rig {
        var looker: PointsLooker
        var tokens: PointsActionTokens
        var captures: Counter
        var secure: Box<Bool>
        var painted: Box<CGImage?>
        var masks: Box<PointsMaskFrames>
    }

    private func rig(
        bundleId: String = "com.apple.Safari", masks: [CGRect]? = nil, complete: Bool = true, scale: CGFloat = 1, access: Bool = true,
        captureFrame: CGRect? = nil
    ) -> Rig {
        let tokens = PointsActionTokens()
        let captures = Counter()
        let secure = Box(false)
        let painted = Box<CGImage?>(nil)
        let m = Box(PointsMaskFrames(window: window, frames: masks ?? [password, card], complete: complete))
        let size = PointsLookGeometry.imageSize(window: window, scale: scale)
        let env = PointsLookEnvironment(
            secureInput: { secure.value }, settings: { TierSettings(defaultValue: .ask) }, bundleId: { _ in bundleId }, hasScreenAccess: { access },
            capture: { _, _ in
                captures.bump()
                return PointsLookCapture(image: Fixture.white(size.width, size.height), frame: captureFrame ?? window)
            },
            encode: { image in
                painted.value = image
                return (Data([0xFF, 0xD8, 0xFF]), "image/jpeg")
            })
        let looker = PointsLooker(pid: 42, bundleId: bundleId, tokens: tokens, environment: env, maskFrames: { m.value })
        return Rig(looker: looker, tokens: tokens, captures: captures, secure: secure, painted: painted, masks: m)
    }

    private func refusal(_ r: Rig, _ actionId: String) async -> String? {
        do { _ = try await r.looker.look(actionId: actionId); return nil } catch let e as CapabilityError { return e.reason } catch { return "other" }
    }

    // MARK: masks

    @Test func theFrameComesBackPaintedWhereTheSensitiveFramesWere() async throws {
        let r = rig()
        let out = try await r.looker.look(actionId: r.tokens.issue())
        let image = try #require(r.painted.value)
        #expect(out.result.masked)
        #expect(out.result.width == image.width && out.result.height == image.height)
        // Window-local 1 pt = 1 px: the password field is x 50..150, y 50..70, the card x 50..170, y 150..170 (padding 6).
        for (x, y) in [(60, 60), (50, 50), (149, 69), (45, 45)] { #expect(Fixture.isBlack(Fixture.pixel(image, x, y)), "password (\(x), \(y))") }
        for (x, y) in [(60, 160), (169, 169), (45, 145)] { #expect(Fixture.isBlack(Fixture.pixel(image, x, y)), "card (\(x), \(y))") }
        // The rest is the page, untouched.
        for (x, y) in [(10, 10), (300, 100), (60, 110), (60, 250), (390, 290)] { #expect(Fixture.isWhite(Fixture.pixel(image, x, y)), "page (\(x), \(y))") }
    }

    @Test func control_withNoSensitiveFramesNothingIsPainted() async throws {
        let r = rig(masks: [])
        let out = try await r.looker.look(actionId: r.tokens.issue())
        let image = try #require(r.painted.value)
        #expect(out.result.masked, "the mask step ran; there was nothing to paint")
        for (x, y) in [(0, 0), (60, 60), (60, 160), (399, 299), (200, 150)] { #expect(Fixture.isWhite(Fixture.pixel(image, x, y)), "(\(x), \(y))") }
    }

    @Test func aRetinaPictureIsPaintedAtItsOwnScale() async throws {
        let r = rig(scale: 2)
        _ = try await r.looker.look(actionId: r.tokens.issue())
        let image = try #require(r.painted.value)
        #expect(image.width == 800 && image.height == 600, "400 x 300 pt at 2x")
        // The password field is x 100..300, y 100..140 px at 2x.
        for (x, y) in [(110, 110), (299, 139), (90, 90)] { #expect(Fixture.isBlack(Fixture.pixel(image, x, y)), "(\(x), \(y))") }
        for (x, y) in [(110, 220), (400, 300), (10, 10)] { #expect(Fixture.isWhite(Fixture.pixel(image, x, y)), "(\(x), \(y))") }
    }

    /// A looker whose two mask reads (before and after the capture) are given.
    private func twoReads(_ first: PointsMaskFrames, _ second: PointsMaskFrames) -> (PointsLooker, PointsActionTokens, Box<CGImage?>) {
        let reads = Counter()
        let tokens = PointsActionTokens()
        let painted = Box<CGImage?>(nil)
        let env = PointsLookEnvironment(
            secureInput: { false }, settings: { TierSettings(defaultValue: .ask) }, bundleId: { _ in "com.apple.Safari" }, hasScreenAccess: { true },
            capture: { _, _ in PointsLookCapture(image: Fixture.white(400, 300), frame: window) },
            encode: { painted.value = $0; return (Data([1]), "image/jpeg") })
        let looker = PointsLooker(
            pid: 42, bundleId: "com.apple.Safari", tokens: tokens, environment: env,
            maskFrames: { reads.bump(); return reads.value == 1 ? first : second })
        return (looker, tokens, painted)
    }

    private func reason(_ looker: PointsLooker, _ tokens: PointsActionTokens) async -> String? {
        do { _ = try await looker.look(actionId: tokens.issue()); return nil } catch let e as CapabilityError { return e.reason } catch { return "other" }
    }

    @Test func aFieldThatAppearedDuringTheCaptureMeansNoPicture() async {
        let (looker, tokens, painted) = twoReads(
            PointsMaskFrames(window: window, frames: [password], complete: true),
            PointsMaskFrames(window: window, frames: [password, card], complete: true))
        #expect(await reason(looker, tokens) == "page_moved")
        #expect(painted.value == nil, "nothing was encoded")
    }

    @Test func aScrollDuringTheCaptureMeansNoPictureAndIsRetryable() async {
        // The password field moved 100 pt between the two reads: the picture is somewhere in between.
        let (looker, tokens, painted) = twoReads(
            PointsMaskFrames(window: window, frames: [password], complete: true),
            PointsMaskFrames(window: window, frames: [password.offsetBy(dx: 0, dy: 100)], complete: true))
        do {
            _ = try await looker.look(actionId: tokens.issue())
            Issue.record("expected a refusal")
        } catch let e as CapabilityError {
            #expect(e.reason == "page_moved" && e.retryable)
        } catch { Issue.record("other error") }
        #expect(painted.value == nil)
    }

    @Test func aDriftWithinTheMaskMarginIsPaintedAtBothPositions() async throws {
        // Control for the two above: a 4 pt drift is inside the 6 pt margin, and both places are painted.
        let (looker, tokens, painted) = twoReads(
            PointsMaskFrames(window: window, frames: [password], complete: true),
            PointsMaskFrames(window: window, frames: [password.offsetBy(dx: 0, dy: 4)], complete: true))
        _ = try await looker.look(actionId: tokens.issue())
        let image = try #require(painted.value)
        // Local y of the field: 50..70; moved copy 54..74; padded together 44..80.
        for y in [45, 60, 79] { #expect(Fixture.isBlack(Fixture.pixel(image, 100, y)), "y \(y)") }
        #expect(Fixture.isWhite(Fixture.pixel(image, 100, 100)))
    }

    @Test func aDirectionsOnlyPageIsNeverLookedAt() async {
        // Checkout, plain http: and venue pages: every field is sensitive, and no picture is taken.
        let r = rig()
        r.masks.value = PointsMaskFrames(window: window, frames: [password], complete: true, directionsOnly: true)
        #expect(await refusal(r, r.tokens.issue()) == "directions_only")
        #expect(r.captures.value == 0)
        // Control: the same page not directions-only is looked at.
        r.masks.value = PointsMaskFrames(window: window, frames: [password], complete: true, directionsOnly: false)
        #expect(await refusal(r, r.tokens.issue()) == nil)
        // A page that turns directions-only during the capture is refused too, and nothing is encoded.
        let (looker, tokens, painted) = twoReads(
            PointsMaskFrames(window: window, frames: [password], complete: true),
            PointsMaskFrames(window: window, frames: [password], complete: true, directionsOnly: true))
        #expect(await reason(looker, tokens) == "directions_only")
        #expect(painted.value == nil)
    }

    @Test func aMaskThatCannotBeTrustedMeansNoPicture() async {
        // The read hit a cap, or a sensitive field had no frame: incomplete.
        let incomplete = rig(complete: false)
        #expect(await refusal(incomplete, incomplete.tokens.issue()) == "mask_unavailable")
        #expect(incomplete.captures.value == 0, "no capture was attempted")
        // The window itself could not be read.
        let noWindow = rig()
        noWindow.masks.value = PointsMaskFrames(window: nil, frames: [], complete: true)
        #expect(await refusal(noWindow, noWindow.tokens.issue()) == "mask_unavailable")
        #expect(noWindow.captures.value == 0)
    }

    @Test func aWindowThatMovedDuringTheCaptureIsRefused() async {
        let r = rig(captureFrame: window.offsetBy(dx: 40, dy: 0))
        #expect(await refusal(r, r.tokens.issue()) == "window_moved")
        #expect(r.painted.value == nil, "nothing was encoded")
    }

    // MARK: refusals

    @Test func aLookNeedsAFreshActionId() async {
        let r = rig()
        for bad in ["", "act-1", "made-up"] { #expect(await refusal(r, bad) == "action_unknown", "\(bad)") }
        #expect(r.captures.value == 0)
        // Positive control: the id the helper issued works.
        #expect(await refusal(r, r.tokens.issue()) == nil)
        #expect(r.captures.value == 1)
    }

    @Test func anActionIdWorksOnce() async {
        let r = rig()
        let id = r.tokens.issue()
        #expect(await refusal(r, id) == nil)
        #expect(await refusal(r, id) == "action_used")
        #expect(r.captures.value == 1, "the replay took no picture")
    }

    @Test func aLookIsRefusedUnderSecureEventInput() async {
        let r = rig()
        r.secure.value = true
        #expect(await refusal(r, r.tokens.issue()) == "secure_input")
        #expect(r.captures.value == 0)
        // Control: the same rig takes a picture once the keyboard is not secure.
        r.secure.value = false
        #expect(await refusal(r, r.tokens.issue()) == nil)
    }

    @Test func aLookIsRefusedWhenTheKeyboardWentSecureDuringTheCapture() async {
        let tokens = PointsActionTokens()
        let secure = Box(false)
        let painted = Box<CGImage?>(nil)
        let env = PointsLookEnvironment(
            secureInput: { secure.value }, settings: { TierSettings(defaultValue: .ask) }, bundleId: { _ in "com.apple.Safari" }, hasScreenAccess: { true },
            capture: { _, _ in secure.value = true; return PointsLookCapture(image: Fixture.white(400, 300), frame: window) },
            encode: { painted.value = $0; return (Data([1]), "image/jpeg") })
        let looker = PointsLooker(
            pid: 42, bundleId: "com.apple.Safari", tokens: tokens, environment: env, maskFrames: { PointsMaskFrames(window: window, frames: [], complete: true) })
        do {
            _ = try await looker.look(actionId: tokens.issue())
            Issue.record("expected a refusal")
        } catch let e as CapabilityError { #expect(e.reason == "secure_input") } catch { Issue.record("other error") }
        #expect(painted.value == nil, "the frame was dropped before it was encoded")
    }

    @Test func everySection22AppIsRefusedAndNoPictureIsTaken() async {
        for id in ["com.1password.1password", "com.apple.Passwords", "com.chase.mac", "com.robinhood.macos", "com.apple.Terminal", "com.psyche.desktop", "com.apple.systempreferences"] {
            let r = rig(bundleId: id)
            #expect(await refusal(r, r.tokens.issue()) == "points_refused", "\(id)")
            #expect(r.captures.value == 0, "\(id)")
        }
        for id in ["com.apple.Safari", "com.google.Chrome"] {
            let r = rig(bundleId: id)
            #expect(await refusal(r, r.tokens.issue()) == nil, "\(id)")
        }
    }

    @Test func aPidTakenOverByAnotherAppIsRefused() async {
        let tokens = PointsActionTokens()
        let env = PointsLookEnvironment(
            secureInput: { false }, settings: { TierSettings(defaultValue: .ask) }, bundleId: { _ in "com.apple.Notes" }, hasScreenAccess: { true },
            capture: { _, _ in Issue.record("captured the wrong app"); return PointsLookCapture(image: Fixture.white(4, 4), frame: window) },
            encode: { _ in (Data(), "") })
        let looker = PointsLooker(pid: 42, bundleId: "com.apple.Safari", tokens: tokens, environment: env, maskFrames: { PointsMaskFrames(window: window, frames: [], complete: true) })
        do {
            _ = try await looker.look(actionId: tokens.issue())
            Issue.record("expected a refusal")
        } catch let e as CapabilityError { #expect(e.reason == "not_a_window") } catch { Issue.record("other error") }
    }

    @Test func missingScreenRecordingIsReportedAndSpendsNoCapture() async {
        let r = rig(access: false)
        do {
            _ = try await r.looker.look(actionId: r.tokens.issue())
            Issue.record("expected a refusal")
        } catch let e as CapabilityError { #expect(e.reason == "permission_missing") } catch { Issue.record("other error") }
        #expect(r.captures.value == 0)
    }

    // MARK: the result

    @Test func theResultCarriesTheSizeTheScaleAndTheRecordForBoxMapping() async throws {
        let r = rig(scale: 2)
        let out = try await r.looker.look(actionId: r.tokens.issue())
        #expect(out.result.width == 800 && out.result.height == 600)
        #expect(out.result.pointsPerPixel == 0.5)
        #expect(out.result.image == Data([0xFF, 0xD8, 0xFF]).base64EncodedString())
        #expect(out.record.window == window)
        #expect(out.record.imageSize == CGSize(width: 800, height: 600))
        #expect(out.record.masks == [password, card])
    }
}
