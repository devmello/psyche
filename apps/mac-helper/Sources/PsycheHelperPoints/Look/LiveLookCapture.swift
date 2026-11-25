import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import PsycheCapture
import PsycheHelperCore
import PsycheProtocol
@preconcurrency import ScreenCaptureKit

/// The live side of `points.look`: ScreenCaptureKit with a content filter for ONE window
/// (`SCContentFilter(desktopIndependentWindow:)`), so no other window, no desktop and no Psyche overlay
/// is in the frame (§5.3). The window is picked by its frame matching the AX window the session reads,
/// never "the largest window of the app". No capture reaches a file: the frame stays in memory.
extension PointsLookEnvironment {
    static let live = PointsLookEnvironment(
        secureInput: { IsSecureEventInputEnabled() },
        settings: { TierSettings.load(path: TierSettings.path()) },
        bundleId: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier },
        hasScreenAccess: { CGPreflightScreenCaptureAccess() },
        capture: { pid, axFrame in try await LivePointsCapture.window(pid: pid, axFrame: axFrame) },
        encode: { try WindowCapture.encode($0, png: false) })
}

enum LivePointsCapture {
    static func window(pid: pid_t, axFrame: CGRect) async throws -> PointsLookCapture {
        let content = try await WindowCapture.shareable()
        let matches = content.windows.filter {
            $0.owningApplication?.processID == pid && $0.isOnScreen && $0.windowLayer == 0 && PointsGeometry.sameWindow(axFrame, $0.frame)
        }
        guard let w = matches.first else {
            throw CapabilityError(.notFound, reason: "no_window", "That window is not on screen")
        }
        // Two windows of the same size in the same place: which one the owner means is unknown.
        guard matches.count == 1 else {
            throw CapabilityError(.conflict, reason: "ambiguous_window", "Two windows share that place; no picture was taken")
        }
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let size = PointsLookGeometry.imageSize(window: w.frame, scale: CGFloat(filter.pointPixelScale))
        guard size.width > 0, size.height > 0 else { throw CapabilityError(.notFound, reason: "no_window", "That window has no size") }
        let config = SCStreamConfiguration()
        config.width = size.width
        config.height = size.height
        config.showsCursor = false
        config.capturesAudio = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        return PointsLookCapture(image: image, frame: w.frame)
    }
}
