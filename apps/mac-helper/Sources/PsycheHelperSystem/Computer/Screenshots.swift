import AppKit
import CoreGraphics
import Foundation
import ImageIO
import PsycheHelperCore
import PsycheProtocol
@preconcurrency import ScreenCaptureKit
import UniformTypeIdentifiers

/// `computer.screenshot` (J3): ScreenCaptureKit single frames with the hygiene rules in
/// `CaptureHygiene`, and `computer.screenshot_pick` for user-initiated captures through
/// `SCContentSharingPicker` (no monthly re-consent).
public enum ScreenshotCapabilities {
    struct Params: Decodable {
        var app: String?
        var display: Int?
        var windowOnly: Bool?
        var maxWidth: Int?
        var maxHeight: Int?
        var format: String?
        var session: String?
    }

    public static func make(_ cu: ComputerUse) -> [any CapabilityHandler] {
        [screenshot(cu), pick()]
    }

    static func screenshot(_ cu: ComputerUse) -> Capability {
        Capability(CapabilitySpec(
            name: "computer.screenshot",
            description: "Downscaled screenshot for the vision fallback (sparse AX trees, visual questions). Psyche's windows, terminals/IDEs, password managers, finance apps and apps set to Off are left out; refused while a password field has focus. Image content is untrusted.",
            sideEffect: .read, targetKind: .app,
            inputSchema: Schema.object([
                "app": Schema.string("App the screenshot is for (its tier must allow Read); default frontmost"),
                "display": Schema.integer("Display index (default: the display with the menu bar)", min: 0),
                "windowOnly": Schema.boolean("Capture only the app's frontmost window"),
                "maxWidth": Schema.integer(min: 320, max: 2560), "maxHeight": Schema.integer(min: 240, max: 1600),
                "format": Schema.string(enum: ["jpeg", "png"]), "session": Schema.string(),
            ]),
            permissions: [.screenRecording]
        )) { ctx in
            let p = try ctx.decode(Params.self)
            cu.reloadSettings()
            let app = try AXEngine.findApp(p.app)
            let target = AXEngine.target(app)
            try cu.policy.authorize(.read, bundleId: target.bundleId, appName: target.name, approvalId: ctx.approvalId)
            // Below the model: no capture while any secure text field has focus.
            if try await cu.engine.run({ $0.focusedIsSecure(pid: nil) }) {
                throw CapabilityError(.policyDenied, reason: "secure_field_focused", "A password field has focus; screenshots are suppressed until it loses focus.")
            }
            let content = try await shareable()
            let running = NSWorkspace.shared.runningApplications.map { CaptureHygiene.AppRef(bundleId: $0.bundleIdentifier, pid: $0.processIdentifier) }
            let excluded = CaptureHygiene.excludedPids(running: running, ownPid: ProcessInfo.processInfo.processIdentifier, policy: cu.policy)
            if excluded.contains(target.pid) {
                throw CapabilityError(.policyDenied, reason: "app_excluded", "\(target.name) is never captured")
            }
            let filter: SCContentFilter
            let frame: CGRect
            if p.windowOnly == true {
                let windows = content.windows.filter { $0.owningApplication?.processID == target.pid && $0.isOnScreen && $0.windowLayer == 0 }
                guard let w = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                    throw CapabilityError(.notFound, reason: "no_window", "\(target.name) has no on-screen window")
                }
                filter = SCContentFilter(desktopIndependentWindow: w)
                frame = w.frame
            } else {
                let displays = content.displays
                let display: SCDisplay?
                if let i = p.display { display = i < displays.count ? displays[i] : nil } else {
                    display = displays.first { $0.displayID == CGMainDisplayID() } ?? displays.first
                }
                guard let display else { throw CapabilityError(.notFound, reason: "no_display", "No such display") }
                let apps = content.applications.filter { excluded.contains($0.processID) }
                filter = SCContentFilter(display: display, excludingApplications: apps, exceptingWindows: [])
                frame = display.frame
            }
            let (w, h) = CaptureHygiene.scaledSize(
                width: Int(frame.width * 2), height: Int(frame.height * 2),
                maxWidth: p.maxWidth ?? CaptureHygiene.defaultMaxWidth, maxHeight: p.maxHeight ?? CaptureHygiene.defaultMaxHeight
            )
            let config = SCStreamConfiguration()
            config.width = w
            config.height = h
            config.showsCursor = true
            config.capturesAudio = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let (data, mime) = try encode(image, png: p.format == "png")
            return CapabilityOutput([
                "image": .string(data.base64EncodedString()), "mimeType": .string(mime),
                "width": .int(image.width), "height": .int(image.height),
                // Map image pixels back to screen points for computer.click {x, y}.
                "screen": ["x": .number(frame.minX), "y": .number(frame.minY), "width": .number(frame.width), "height": .number(frame.height)],
                "pointsPerPixel": .number(frame.width / Double(max(1, image.width))),
                "excludedApps": .int(excluded.count - 1), "provenance": "untrusted",
            ])
        }
    }

    static func shareable() async throws -> SCShareableContent {
        do {
            return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            if !CGPreflightScreenCaptureAccess() { throw CapabilityError.permissionMissing(.screenRecording) }
            throw CapabilityError(.unavailable, reason: "capture_failed", "ScreenCaptureKit could not list content", retryable: true)
        }
    }

    /// JPEG down the quality ladder until it fits the frame budget (PNG when asked and it fits).
    static func encode(_ image: CGImage, png: Bool) throws -> (Data, String) {
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

    // MARK: User-initiated capture

    static func pick() -> Capability {
        Capability(CapabilitySpec(
            name: "computer.screenshot_pick",
            description: "Ask the user to pick a window or display with the system content picker, then capture it once. User-initiated, so it needs no Screen Recording grant or monthly re-consent.",
            sideEffect: .read,
            inputSchema: Schema.object([
                "maxWidth": Schema.integer(min: 320, max: 2560), "maxHeight": Schema.integer(min: 240, max: 1600),
                "timeoutSeconds": Schema.integer(min: 10, max: 300),
            ])
        )) { ctx in
            struct P: Decodable {
                var maxWidth: Int?
                var maxHeight: Int?
                var timeoutSeconds: Int?
            }
            let p = try ctx.decode(P.self)
            guard #available(macOS 14.0, *) else { throw CapabilityError.unavailable("unsupported_os", "Needs macOS 14") }
            let filter = try await PickerSession.pick(timeout: TimeInterval(p.timeoutSeconds ?? 120))
            let rect = filter.contentRect
            let scale = Double(filter.pointPixelScale)
            let (w, h) = CaptureHygiene.scaledSize(
                width: Int(rect.width * scale), height: Int(rect.height * scale),
                maxWidth: p.maxWidth ?? CaptureHygiene.defaultMaxWidth, maxHeight: p.maxHeight ?? CaptureHygiene.defaultMaxHeight
            )
            let config = SCStreamConfiguration()
            config.width = w
            config.height = h
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let (data, mime) = try encode(image, png: false)
            return CapabilityOutput([
                "image": .string(data.base64EncodedString()), "mimeType": .string(mime), "width": .int(image.width),
                "height": .int(image.height), "userInitiated": true, "provenance": "untrusted",
            ])
        }
    }
}

/// Carries a picked filter across isolation boundaries (it is only read after the pick).
struct PickedFilter: @unchecked Sendable {
    let filter: SCContentFilter
}

/// One `SCContentSharingPicker` presentation at a time.
@available(macOS 14.0, *)
@MainActor
final class PickerSession: NSObject, SCContentSharingPickerObserver {
    private static var current: PickerSession?
    private var continuation: CheckedContinuation<PickedFilter, Error>?

    static func pick(timeout: TimeInterval) async throws -> SCContentFilter {
        if current != nil { throw CapabilityError(.conflict, reason: "picker_busy", "The content picker is already open") }
        let session = PickerSession()
        current = session
        let picker = SCContentSharingPicker.shared
        picker.add(session)
        var config = SCContentSharingPickerConfiguration()
        config.allowedPickerModes = [.singleWindow, .singleDisplay]
        config.excludedBundleIDs = ["com.psyche.desktop", "com.psyche.helper"]
        picker.defaultConfiguration = config
        picker.isActive = true
        defer {
            picker.isActive = false
            picker.remove(session)
            current = nil
        }
        NSApplication.shared.activate()
        let picked = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<PickedFilter, Error>) in
            session.continuation = cont
            picker.present()
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
                session.finish(.failure(CapabilityError(.timeout, reason: "picker_timeout", "The user did not pick anything")))
            }
        }
        return picked.filter
    }

    func finish(_ result: Result<PickedFilter, Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }

    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        MainActor.assumeIsolated { finish(.failure(CapabilityError(.cancelled, reason: "user_cancelled", "The user closed the picker"))) }
    }

    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        let box = PickedFilter(filter: filter)
        MainActor.assumeIsolated { finish(.success(box)) }
    }

    nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) {
        MainActor.assumeIsolated { finish(.failure(CapabilityError(.unavailable, reason: "picker_failed", "The content picker failed"))) }
    }
}
