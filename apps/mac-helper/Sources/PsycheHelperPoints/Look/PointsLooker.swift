import CoreGraphics
import Foundation
import PsycheCapture
import PsycheHelperCore
import PsycheProtocol

/// One frame of the target window, as the capture layer returns it: the pixels, the window's frame in AX
/// space when it was taken, and its pixel scale.
struct PointsLookCapture {
    var image: CGImage
    var frame: CGRect
}

/// Everything `points.look` reads from the machine, injectable so tests never touch Screen Recording,
/// the real keyboard state or the settings file.
struct PointsLookEnvironment: Sendable {
    var secureInput: @Sendable () -> Bool
    var settings: @Sendable () -> TierSettings
    /// The bundle id of the process now (a pid can be reused by another app).
    var bundleId: @Sendable (pid_t) -> String?
    var hasScreenAccess: @Sendable () -> Bool
    /// One frame of the window whose AX frame is given, and no other window.
    var capture: @Sendable (pid_t, CGRect) async throws -> PointsLookCapture
    /// JPEG down the quality ladder (the wire budget).
    var encode: @Sendable (CGImage) throws -> (Data, String)
}

/// What the session keeps of the last look, to map a vision-mode box back to the screen.
struct PointsLookRecord: Sendable, Equatable {
    var window: CGRect
    var imageSize: CGSize
    var masks: [CGRect]
}

struct PointsLookOutcome {
    var result: PointsLookResult
    var record: PointsLookRecord
}

/// `points.look` (docs/design/psyche-points-2026.md §3.1, §5.2, §5.3): one picture of the target window,
/// taken only for the owner's own click, with every known sensitive field's frame painted solid before
/// the picture is encoded. The picture exists in this process's memory until it is encoded and is never
/// written anywhere. Refusals, in order: an unknown, used or stale `actionId`; Secure Event Input; an app
/// section 2.2 refuses; a window that is no longer the session's; a mask that cannot be trusted to cover
/// every sensitive field.
final class PointsLooker: Sendable {
    let pid: pid_t
    let bundleId: String
    let tokens: PointsActionTokens
    private let env: PointsLookEnvironment
    private let maskFrames: @Sendable () async -> PointsMaskFrames

    init(
        pid: pid_t, bundleId: String, tokens: PointsActionTokens, environment: PointsLookEnvironment,
        maskFrames: @escaping @Sendable () async -> PointsMaskFrames
    ) {
        self.pid = pid
        self.bundleId = bundleId
        self.tokens = tokens
        env = environment
        self.maskFrames = maskFrames
    }

    func look(actionId: String) async throws -> PointsLookOutcome {
        // The id is spent here, before anything else is checked: a refused look needs a new click.
        try PointsLookGate.check(
            actionId: actionId, tokens: tokens, secureInput: env.secureInput, bundleId: bundleId, settings: env.settings())
        // The pid must still be the app the session started on.
        guard env.bundleId(pid) == bundleId else {
            throw CapabilityError(.notFound, reason: "not_a_window", "That window is gone")
        }
        guard env.hasScreenAccess() else { throw CapabilityError.permissionMissing(.screenRecording) }

        let before = await maskFrames()
        guard before.complete, let window = before.window else {
            throw CapabilityError(.unavailable, reason: "mask_unavailable", "Could not tell where the private fields are, so no picture was taken", retryable: true)
        }
        // A payment, plain-http or venue page is directions only (§2.2): no picture of it, whatever is masked.
        if before.directionsOnly {
            throw CapabilityError(.forbidden, reason: "directions_only", "This page is shown as directions only; Psyche does not look at it")
        }
        let shot = try await env.capture(pid, window)
        // The keyboard may have gone secure while the frame was taken: drop it.
        try PointsLookGate.checkNow(secureInput: env.secureInput, bundleId: bundleId, settings: env.settings())
        let after = await maskFrames()
        if after.directionsOnly {
            throw CapabilityError(.forbidden, reason: "directions_only", "This page is shown as directions only; Psyche does not look at it")
        }
        guard after.complete, let windowAfter = after.window, PointsGeometry.sameWindow(window, windowAfter), PointsGeometry.sameWindow(window, shot.frame) else {
            throw CapabilityError(.conflict, reason: "window_moved", "The window moved while the picture was taken; try again", retryable: true)
        }
        // A scroll during the capture leaves the picture somewhere between the two reads: the masks would
        // not sit on the fields. Any frame that moved by more than the mask margin means no picture.
        if PointsFrameDrift.moved(before.frames, after.frames) {
            throw CapabilityError(.conflict, reason: "page_moved", "The page moved while the picture was taken; try again", retryable: true)
        }
        // Frames from before and after the capture: a field that appeared meanwhile is painted too.
        var frames = before.frames
        for f in after.frames where !frames.contains(f) { frames.append(f) }
        let size = (width: shot.image.width, height: shot.image.height)
        let rects = PointsLookGeometry.maskRects(frames: frames, window: shot.frame, imageSize: size)
        guard let painted = ImageMask.paint(shot.image, rects: rects) else {
            throw CapabilityError(.unavailable, reason: "mask_failed", "Could not paint over the private fields, so no picture was sent", retryable: true)
        }
        let (data, _) = try env.encode(painted)
        let result = PointsLookResult(
            height: painted.height, image: data.base64EncodedString(), masked: true,
            pointsPerPixel: PointsLookGeometry.pointsPerPixel(window: shot.frame, imageWidth: painted.width), width: painted.width)
        let record = PointsLookRecord(
            window: shot.frame, imageSize: CGSize(width: painted.width, height: painted.height), masks: frames)
        return PointsLookOutcome(result: result, record: record)
    }
}
