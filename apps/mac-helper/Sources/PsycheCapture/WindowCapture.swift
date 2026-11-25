import CoreGraphics
import Foundation
import ImageIO
import PsycheHelperCore
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers

/// The read-only half of window capture, shared by `PsycheHelperSystem` (computer.screenshot,
/// screen.context) and, later, Psyche points: listing what ScreenCaptureKit may capture and
/// encoding a frame to the wire budget. It links no event-posting, activation or spawn API
/// (docs/design/psyche-points-2026.md §4.3; `scripts/check-points-boundary.sh`).
public enum WindowCapture {
    public static func shareable() async throws -> SCShareableContent {
        do {
            return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            if !CGPreflightScreenCaptureAccess() { throw CapabilityError.permissionMissing(.screenRecording) }
            throw CapabilityError(.unavailable, reason: "capture_failed", "ScreenCaptureKit could not list content", retryable: true)
        }
    }

    /// JPEG down the quality ladder until it fits the frame budget (PNG when asked and it fits).
    public static func encode(_ image: CGImage, png: Bool) throws -> (Data, String) {
        func write(_ type: UTType, quality: Double?) -> Data? {
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
            var props: [CFString: Any] = [:]
            if let quality { props[kCGImageDestinationLossyCompressionQuality] = quality }
            CGImageDestinationAddImage(dest, image, props as CFDictionary)
            return CGImageDestinationFinalize(dest) ? out as Data : nil
        }
        if png, let d = write(.png, quality: nil), d.count <= CaptureHygiene.maxEncodedBytes { return (d, "image/png") }
        for q in CaptureHygiene.jpegQualityLadder {
            if let d = write(.jpeg, quality: q), d.count <= CaptureHygiene.maxEncodedBytes { return (d, "image/jpeg") }
        }
        throw CapabilityError(.unavailable, reason: "image_too_large", "The screenshot does not fit the frame budget; lower maxWidth")
    }
}
