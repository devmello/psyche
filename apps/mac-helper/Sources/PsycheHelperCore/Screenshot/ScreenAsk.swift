import CoreGraphics
import Foundation

/// Ask about my screen (docs/design/screen-ask-2026.md §3.1): the pure rules behind `screen.context`.
/// The owner pressed the ask shortcut, so this is owner-initiated capture, not computer use: tiers
/// and approvals do not apply, but the never-capture list does. Psyche, password managers, finance
/// and system-authority apps are never captured, nor any app the owner set to Off by name (the
/// default `ask` tier is about the agent acting, and does not hide an app from its owner).
public enum ScreenAsk {
    /// Longest selected text a capture carries (`SCREEN_SELECTED_TEXT_MAX`).
    public static let maxSelectedText = 4_000
    public static let maxURLLength = 2_048
    /// Default output bounds: 1600 px on the long side (spec §3.1).
    public static let defaultMaxWidth = 1_600
    public static let defaultMaxHeight = 1_600
    /// Windows smaller than this (tooltips, badges, the voice HUD's shadow) are never the target.
    static let minWindowSide: Double = 40

    /// An on-screen window, front to back as `CGWindowListCopyWindowInfo` lists them.
    public struct WindowRef: Sendable, Equatable {
        public var id: UInt32
        public var pid: Int32
        public var layer: Int
        public var bounds: CGRect
        public var alpha: Double
        public init(id: UInt32, pid: Int32, layer: Int, bounds: CGRect, alpha: Double = 1) {
            self.id = id
            self.pid = pid
            self.layer = layer
            self.bounds = bounds
            self.alpha = alpha
        }
    }

    /// Whether this app is never captured for an ask.
    public static func isExcluded(bundleId: String?, settings: TierSettings) -> Bool {
        switch FixedCaps.category(of: bundleId) {
        case .psyche?, .passwordManager?, .finance?, .systemAuthority?: return true
        default: break
        }
        guard let bundleId else { return false }
        let explicit = settings.apps[bundleId] ?? settings.apps.first { $0.key.lowercased() == bundleId.lowercased() }?.value
        return explicit == .off
    }

    /// The window the owner is looking at: the frontmost normal window that isn't Psyche's own
    /// (the ask panel, the main window). An excluded app's window is still returned, so the caller
    /// refuses it rather than silently capturing whatever is behind it.
    public static func targetWindow(_ windows: [WindowRef], psychePids: Set<Int32>) -> WindowRef? {
        windows.first { w in
            w.layer == 0 && w.alpha > 0 && !psychePids.contains(w.pid)
                && w.bounds.width >= minWindowSide && w.bounds.height >= minWindowSide
        }
    }

    /// The frontmost window under `point` (for region mode's text context).
    public static func window(at point: CGPoint, _ windows: [WindowRef], psychePids: Set<Int32>) -> WindowRef? {
        windows.first { $0.layer == 0 && $0.alpha > 0 && !psychePids.contains($0.pid) && $0.bounds.contains(point) }
    }

    /// The display that holds most of `rect`, and `rect` clipped to it in display-local points.
    /// Nil when the box misses every display or is too small to read.
    public static func region(_ rect: CGRect, displays: [CGRect]) -> (index: Int, local: CGRect)? {
        let r = rect.standardized
        var best: (Int, CGRect, Double)?
        for (i, d) in displays.enumerated() {
            let clip = r.intersection(d)
            guard !clip.isNull, clip.width >= 8, clip.height >= 8 else { continue }
            let area = clip.width * clip.height
            if best == nil || area > best!.2 { best = (i, clip, area) }
        }
        guard let (i, clip, _) = best else { return nil }
        let d = displays[i]
        return (i, CGRect(x: clip.minX - d.minX, y: clip.minY - d.minY, width: clip.width, height: clip.height))
    }

    /// Selected text as the request's context: trimmed, at most `maxSelectedText` characters.
    public static func selection(_ raw: String?) -> String? {
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s.count > maxSelectedText ? String(s.prefix(maxSelectedText)) : s
    }

    /// A browser URL worth sending: http(s) only, without credentials, at most `maxURLLength`.
    public static func url(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              var c = URLComponents(string: raw),
              let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https", c.host != nil
        else { return nil }
        c.user = nil
        c.password = nil
        guard let s = c.string, s.count <= maxURLLength else { return nil }
        return s
    }

    /// A window title worth sending (some apps report "" or whitespace).
    public static func title(_ raw: String?) -> String? {
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return String(s.prefix(512))
    }
}
