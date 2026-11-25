import AppKit
import ApplicationServices
import Foundation
import PsycheAXRead
import PsycheHelperCore
import PsycheProtocol

/// The window list of `points.windows` (docs/design/psyche-points-2026.md §3.2): app and window
/// titles through accessibility, so no Screen Recording is needed. It reads titles and roles only.
enum PointsWindowList {
    static let maxWindows = 200

    /// `ref` of a window as `points.session` takes it: `<pid>:<windowIndex>`.
    static func ref(pid: Int32, index: Int) -> String { "\(pid):\(index)" }

    static func parse(ref: String) -> (pid: pid_t, index: Int)? {
        let parts = ref.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let pid = pid_t(parts[0]), let index = Int(parts[1]), pid > 0, index >= 0 else { return nil }
        return (pid, index)
    }

    static func isWindow(_ w: AXUIElement) -> Bool {
        guard AX.string(AX.attr(w, "AXRole")) == "AXWindow" else { return false }
        switch AX.string(AX.attr(w, "AXSubrole")) {
        case "AXStandardWindow", "AXDialog", "AXFloatingWindow", nil: return true
        default: return false
        }
    }

    /// The standard windows of an app, in AX order (the order `points.session` indexes).
    static func windows(of pid: pid_t) -> [AXUIElement] {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        return AX.elements(AX.attr(app, "AXWindows"))
    }

    static func list(settings: TierSettings, trusted: Bool = AXIsProcessTrusted()) -> [PointsHelperWindow] {
        var out: [PointsHelperWindow] = []
        let selfPid = ProcessInfo.processInfo.processIdentifier
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
            guard let bundleId = app.bundleIdentifier, app.processIdentifier != selfPid else { continue }
            let name = String((app.localizedName ?? bundleId).prefix(120))
            let wapp = PointsHelperWindowApp(bundleID: String(bundleId.prefix(200)), name: name)
            if !trusted {
                out.append(PointsHelperWindow(app: wapp, frontmost: app.processIdentifier == front, pid: Int(app.processIdentifier), refusal: .permissionMissing, title: name, windowIndex: 0))
                continue
            }
            let refusal = PointsPolicy.refusal(bundleId: bundleId, settings: settings)
            for (i, w) in windows(of: app.processIdentifier).enumerated() where isWindow(w) {
                let title = String((AX.string(AX.attr(w, "AXTitle")) ?? "").prefix(200))
                let main = AX.bool(AX.attr(w, "AXMain")) ?? false
                out.append(
                    PointsHelperWindow(
                        app: wapp, frontmost: app.processIdentifier == front && main, pid: Int(app.processIdentifier), refusal: refusal,
                        title: title, windowIndex: i))
                if out.count >= maxWindows { return out }
            }
        }
        return out
    }
}
