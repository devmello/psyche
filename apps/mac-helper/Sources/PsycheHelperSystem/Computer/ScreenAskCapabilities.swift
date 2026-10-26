import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import PsycheHelperCore
import PsycheProtocol
@preconcurrency import ScreenCaptureKit

/// `screen.context` (Ask about my screen, docs/design/screen-ask-2026.md §3.1): one owner-initiated
/// capture of the window the owner is looking at (or a dragged box) plus its cheap text context
/// through AX: app, window title, selected text and the browser URL. The Gateway forwards its
/// desktop-only `screen.capture` here; `nodes.invoke` and agent tools cannot reach it.
///
/// It degrades instead of failing: without Screen Recording, on an excluded app or while a password
/// field has focus there is no image (`refusal` says why), and without Accessibility the context
/// is the app name alone. Everything returned is untrusted content.
public enum ScreenAskCapabilities {
    public static func make() -> [any CapabilityHandler] {
        [
            Capability(CapabilitySpec(
                name: "screen.context",
                description: "Desktop Ask about my screen only: capture the frontmost window (or a box in global points) once, with the app, window title, selected text and browser URL. Psyche, password managers, finance apps and apps set to Off are never captured; no image while a password field has focus. Content is untrusted.",
                sideEffect: .read,
                inputSchema: Schema.object([
                    "mode": Schema.string(enum: ["window", "region"]),
                    "rect": Schema.object([
                        "x": Schema.number(), "y": Schema.number(), "width": Schema.number(), "height": Schema.number(),
                    ], required: ["x", "y", "width", "height"]),
                    "maxWidth": Schema.integer(min: 320, max: 2560), "maxHeight": Schema.integer(min: 240, max: 1600),
                ], required: ["mode"])
            )) { ctx in
                let p = try ctx.decode(ScreenContextParams.self)
                return CapabilityOutput(try JSONValue(encoding: try await capture(p)))
            },
        ]
    }

    static func capture(_ p: ScreenContextParams) async throws -> ScreenContextResult {
        let settings = TierSettings.load(path: TierSettings.path())
        let windows = onScreenWindows()
        let psyche = psychePids()
        let rect = p.rect.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }
        if p.mode == .region, rect == nil {
            throw CapabilityError.invalidParams("Region mode needs a rect", field: "rect")
        }
        let target: ScreenAsk.WindowRef? = switch p.mode {
        case .window: ScreenAsk.targetWindow(windows, psychePids: psyche)
        case .region: ScreenAsk.window(at: CGPoint(x: rect!.midX, y: rect!.midY), windows, psychePids: psyche)
        }
        let app = target.flatMap { NSRunningApplication(processIdentifier: $0.pid) } ?? NSWorkspace.shared.frontmostApplication
        let bundleId = app?.bundleIdentifier
        let appName = app?.localizedName ?? bundleId ?? "Unknown app"

        func result(_ context: ScreenContext?, refusal: ScreenCaptureRefusal) -> ScreenContextResult {
            ScreenContextResult(context: context, height: 0, image: nil, refusal: refusal, width: 0)
        }
        // An excluded app gives its name and nothing else: no title, URL or selection.
        if ScreenAsk.isExcluded(bundleId: bundleId, settings: settings) {
            return result(ScreenContext(appName: appName, bundleID: bundleId, selectedText: nil, url: nil, windowTitle: nil), refusal: .appExcluded)
        }
        let focus = AXEngine.keyboardFocus()
        let context = textContext(app: app, appName: appName, target: target, secureFocus: focus.secure)
        if focus.secure { return result(context, refusal: .secureField) }
        if p.mode == .window, target == nil { return result(context, refusal: .noWindow) }
        guard CGPreflightScreenCaptureAccess() else { return result(context, refusal: .permissionMissing) }

        let content = try await ScreenshotCapabilities.shareable()
        let running = NSWorkspace.shared.runningApplications
        let excludedApps = content.applications.filter { a in
            psyche.contains(a.processID)
                || ScreenAsk.isExcluded(bundleId: running.first { $0.processIdentifier == a.processID }?.bundleIdentifier, settings: settings)
        }
        let filter: SCContentFilter
        let source: CGRect?
        let points: CGSize
        let scale: Double
        switch p.mode {
        case .window:
            guard let w = content.windows.first(where: { $0.windowID == target!.id }) else { return result(context, refusal: .noWindow) }
            filter = SCContentFilter(desktopIndependentWindow: w)
            source = nil
            points = w.frame.size
            scale = Double(filter.pointPixelScale)
        case .region:
            let displays = content.displays
            guard let (i, local) = ScreenAsk.region(rect!, displays: displays.map(\.frame)) else { return result(context, refusal: .noWindow) }
            filter = SCContentFilter(display: displays[i], excludingApplications: excludedApps, exceptingWindows: [])
            source = local
            points = local.size
            scale = Double(filter.pointPixelScale)
        }
        let (w, h) = CaptureHygiene.scaledSize(
            width: Int(points.width * scale), height: Int(points.height * scale),
            maxWidth: p.maxWidth ?? ScreenAsk.defaultMaxWidth, maxHeight: p.maxHeight ?? ScreenAsk.defaultMaxHeight
        )
        let config = SCStreamConfiguration()
        config.width = w
        config.height = h
        config.showsCursor = false
        config.capturesAudio = false
        if let source { config.sourceRect = source }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let (data, _) = try ScreenshotCapabilities.encode(image, png: false)
        return ScreenContextResult(context: context, height: image.height, image: data.base64EncodedString(), refusal: nil, width: image.width)
    }

    /// App, window title, selected text and browser URL. Without Accessibility only the app name.
    static func textContext(app: NSRunningApplication?, appName: String, target: ScreenAsk.WindowRef?, secureFocus: Bool) -> ScreenContext {
        let bundleId = app?.bundleIdentifier
        guard let app, AXIsProcessTrusted() else {
            return ScreenContext(appName: appName, bundleID: bundleId, selectedText: nil, url: nil, windowTitle: nil)
        }
        let ae = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ae, 0.5)
        let window = AX.element(AX.attr(ae, "AXFocusedWindow")) ?? AX.element(AX.attr(ae, "AXMainWindow"))
        let title = ScreenAsk.title(window.flatMap { AX.string(AX.attr($0, "AXTitle")) })
        var selected: String?
        if !secureFocus, let f = AX.element(AX.attr(ae, "AXFocusedUIElement")),
           AX.string(AX.attr(f, "AXSubrole")) != "AXSecureTextField" {
            selected = ScreenAsk.selection(AX.string(AX.attr(f, "AXSelectedText")))
        }
        var url: String?
        if FixedCaps.category(of: bundleId) == .browser, let window {
            url = ScreenAsk.url(webAreaURL(window))
        }
        return ScreenContext(appName: appName, bundleID: bundleId, selectedText: selected, url: url, windowTitle: title)
    }

    /// The first web area's `AXURL` under the window, breadth first, bounded.
    static func webAreaURL(_ root: AXUIElement) -> String? {
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        while !queue.isEmpty, visited < 400 {
            let (e, depth) = queue.removeFirst()
            visited += 1
            if AX.string(AX.attr(e, "AXRole")) == "AXWebArea" {
                if let u = AX.attr(e, "AXURL") {
                    if let url = u as? URL { return url.absoluteString }
                    if CFGetTypeID(u) == CFURLGetTypeID() { return (u as! CFURL as URL).absoluteString }
                    if let s = AX.string(u) { return s }
                }
            }
            if depth < 14 { queue += AX.elements(AX.attr(e, "AXChildren")).map { ($0, depth + 1) } }
        }
        return nil
    }

    static func onScreenWindows() -> [ScreenAsk.WindowRef] {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { d in
            guard let id = d[kCGWindowNumber as String] as? UInt32, let pid = d[kCGWindowOwnerPID as String] as? Int32,
                  let b = d[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: b)
            else { return nil }
            return ScreenAsk.WindowRef(id: id, pid: pid, layer: d[kCGWindowLayer as String] as? Int ?? 0, bounds: bounds,
                                       alpha: d[kCGWindowAlpha as String] as? Double ?? 1)
        }
    }

    /// The helper and every Psyche app (the desktop shell and its helpers).
    static func psychePids() -> Set<Int32> {
        var out: Set<Int32> = [ProcessInfo.processInfo.processIdentifier]
        for a in NSWorkspace.shared.runningApplications where FixedCaps.category(of: a.bundleIdentifier) == .psyche {
            out.insert(a.processIdentifier)
        }
        return out
    }
}
