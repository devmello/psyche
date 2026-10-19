import CoreGraphics
import Foundation

/// Screenshot hygiene rules (feature J3; security §12 "Screenshot and window hygiene"): Psyche's own
/// windows and the user's terminals/IDEs are never captured, nor any app whose tier is Off
/// (password managers, banking); captures are downscaled; nothing is captured while a secure text
/// field has focus.
public enum CaptureHygiene {
    public struct AppRef: Sendable, Equatable {
        public var bundleId: String?
        public var pid: Int32
        public init(bundleId: String?, pid: Int32) {
            self.bundleId = bundleId
            self.pid = pid
        }
    }

    /// Default longest-edge bounds (the Claude app downsizes 3456×2234 to about 1372×887).
    public static let defaultMaxWidth = 1372
    public static let defaultMaxHeight = 887
    /// Encoded image budget so a result stays far below the 1 MiB frame limit after base64.
    public static let maxEncodedBytes = 600_000
    public static let jpegQualityLadder: [Double] = [0.75, 0.6, 0.45, 0.3]

    /// Pids whose windows must be excluded from a capture.
    public static func excludedPids(running: [AppRef], ownPid: Int32, policy: TierPolicy) -> Set<Int32> {
        var out: Set<Int32> = [ownPid]
        for app in running {
            switch FixedCaps.category(of: app.bundleId) {
            case .psyche?, .terminalOrIDE?, .passwordManager?, .finance?:
                out.insert(app.pid)
            default:
                if policy.effectiveTier(for: app.bundleId) == .off, !isSystemUI(app.bundleId) {
                    // Apps the user set to Off are not shown to the model either. Unknown apps in
                    // `ask` count as Off until approved; the Dock, menu bar and wallpaper stay.
                    out.insert(app.pid)
                }
            }
        }
        return out
    }

    /// System processes that draw shared chrome; excluding them blanks the desktop.
    static func isSystemUI(_ bundleId: String?) -> Bool {
        guard let id = bundleId else { return true }
        return ["com.apple.dock", "com.apple.WindowManager", "com.apple.controlcenter", "com.apple.systemuiserver",
                "com.apple.finder", "com.apple.notificationcenterui", "com.apple.Spotlight", "com.apple.wallpaper.agent"]
            .contains(id)
    }

    /// Output size that fits `maxWidth`×`maxHeight`, preserving aspect ratio, never upscaling.
    public static func scaledSize(width: Int, height: Int, maxWidth: Int = defaultMaxWidth, maxHeight: Int = defaultMaxHeight) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (0, 0) }
        let scale = min(1, min(Double(maxWidth) / Double(width), Double(maxHeight) / Double(height)))
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }
}
