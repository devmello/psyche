import AppKit
import CoreGraphics
import PsycheHelperCore

/// Reads of the display layout and of the window list, converted to AX space (§4.2). Reads only:
/// `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` bounds and owner pids need no Screen Recording.
@MainActor
enum PointsScreens {
    /// The primary display's height: the origin of the AppKit to AX flip.
    static var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    static func displays() -> [PointsDisplay] {
        let h = primaryHeight
        return NSScreen.screens.map { s in
            PointsDisplay(
                frame: PointsGeometry.axRect(fromAppKit: s.frame, primaryHeight: h),
                visible: PointsGeometry.axRect(fromAppKit: s.visibleFrame, primaryHeight: h),
                scale: s.backingScaleFactor)
        }
    }
}

enum PointsWindowProbe {
    /// The target window is on screen on the active Space: some on-screen, normal-layer window of the
    /// process has the AX window's bounds. With no frame to compare, any such window of the process counts.
    static func isOnScreen(pid: pid_t, frame: CGRect?) -> Bool {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return true  // cannot tell: do not hide the pointer on a failed read
        }
        for w in list {
            guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
            guard let frame else { return true }
            if let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b as CFDictionary),
               PointsGeometry.sameWindow(frame, r)
            {
                return true
            }
        }
        return false
    }
}
