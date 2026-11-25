import CoreGraphics
import Foundation

// The pure maths of Psyche points vision mode (docs/design/psyche-points-2026.md §3.1, §5.2): how big
// the picture of the window is, where a sensitive frame lands in that picture, and where a box the
// model answered with lands on the screen. All screen rectangles are in AX space (global points, top-left
// origin); all image rectangles are in pixels with the origin at the top-left corner of the image.
// Nothing here touches ScreenCaptureKit or AppKit, so Retina and multi-display cases are unit-tested.

public enum PointsLookGeometry {
    /// The picture sent to the model is at most this large (§5.2).
    public static let maxWidth = 1372
    public static let maxHeight = 887
    /// How far a mask reaches beyond the field's frame, in points (a focus ring, a shadow, a clipped label).
    public static let maskPadding: CGFloat = 6

    /// The captured size in pixels for a window of `window` points on a display with `scale` pixels per
    /// point (2 on Retina), cut to the budget, aspect ratio kept, never enlarged.
    public static func imageSize(window: CGRect, scale: CGFloat) -> (width: Int, height: Int) {
        guard window.width.isFinite, window.height.isFinite, scale.isFinite, window.width > 0, window.height > 0, scale > 0 else { return (0, 0) }
        return CaptureHygiene.scaledSize(
            width: Int((window.width * scale).rounded()), height: Int((window.height * scale).rounded()), maxWidth: maxWidth, maxHeight: maxHeight)
    }

    /// Points per image pixel: what `points.look` reports as `pointsPerPixel`.
    public static func pointsPerPixel(window: CGRect, imageWidth: Int) -> Double {
        guard imageWidth > 0 else { return 0 }
        return Double(window.width) / Double(imageWidth)
    }

    /// The pixel rectangles to paint over a picture of `window` for these screen `frames` (every known
    /// sensitive field). Each is grown by `padding` points, cut to the window and rounded outward to whole
    /// pixels, so a mask never ends short of the field. Frames wholly outside the window are dropped (they
    /// are not in the picture); a frame with a NaN or an infinite side is painted over the whole picture
    /// instead of being trusted.
    public static func maskRects(
        frames: [CGRect], window: CGRect, imageSize: (width: Int, height: Int), padding: CGFloat = maskPadding
    ) -> [CGRect] {
        guard imageSize.width > 0, imageSize.height > 0, window.width > 0, window.height > 0 else { return [] }
        let full = CGRect(x: 0, y: 0, width: imageSize.width, height: imageSize.height)
        let sx = CGFloat(imageSize.width) / window.width
        let sy = CGFloat(imageSize.height) / window.height
        var out: [CGRect] = []
        for f in frames {
            guard f.origin.x.isFinite, f.origin.y.isFinite, f.width.isFinite, f.height.isFinite else { return [full] }
            let grown = f.insetBy(dx: -padding, dy: -padding).intersection(window)
            if grown.isNull || grown.isEmpty { continue }
            let x0 = floor((grown.minX - window.minX) * sx)
            let y0 = floor((grown.minY - window.minY) * sy)
            let x1 = ceil((grown.maxX - window.minX) * sx)
            let y1 = ceil((grown.maxY - window.minY) * sy)
            let r = CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0).intersection(full)
            if !r.isNull, !r.isEmpty { out.append(r) }
        }
        return out
    }
}

public enum PointsBoxMapping {
    /// A box the model drew on the picture (image pixels) mapped to the screen. `imageSize` is the picture
    /// the model saw; `window` is the target window's frame when it was captured. The result is cut to the
    /// window and then to the displays: where the window spans two displays, the part on the display that
    /// holds most of the box. Nil when the box is malformed, lies outside the window, or the window is
    /// off every display. Retina makes no difference: the ratio is window points over image pixels.
    public static func screenRect(box: CGRect, imageSize: CGSize, window: CGRect, displays: [CGRect]) -> CGRect? {
        guard box.origin.x.isFinite, box.origin.y.isFinite, box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0 else { return nil }
        guard imageSize.width.isFinite, imageSize.height.isFinite, imageSize.width > 0, imageSize.height > 0 else { return nil }
        guard window.width > 0, window.height > 0, window.origin.x.isFinite, window.origin.y.isFinite else { return nil }
        let sx = window.width / imageSize.width
        let sy = window.height / imageSize.height
        let mapped = CGRect(
            x: window.minX + box.minX * sx, y: window.minY + box.minY * sy, width: box.width * sx, height: box.height * sy
        ).intersection(window)
        if mapped.isNull || mapped.isEmpty { return nil }
        if displays.isEmpty { return mapped }
        var best: CGRect?
        var bestArea: CGFloat = 0
        for d in displays {
            let part = mapped.intersection(d)
            if part.isNull || part.isEmpty { continue }
            let area = part.width * part.height
            if area > bestArea { best = part; bestArea = area }
        }
        return best
    }

    /// Whether a mapped box touches any masked (sensitive) frame: such a box is pointed at, never offered a value.
    public static func touchesAny(_ box: CGRect, in frames: [CGRect]) -> Bool {
        frames.contains { f in
            guard f.origin.x.isFinite, f.origin.y.isFinite, f.width.isFinite, f.height.isFinite else { return true }
            return f.insetBy(dx: -PointsLookGeometry.maskPadding, dy: -PointsLookGeometry.maskPadding).intersects(box)
        }
    }

    /// The model's and the helper's pictures agree when their sizes have the same shape (a Gateway that
    /// resized the picture is fine; a box drawn on a different picture is not).
    public static func sameShape(_ a: CGSize, _ b: CGSize, tolerance: CGFloat = 0.03) -> Bool {
        guard a.width > 0, a.height > 0, b.width > 0, b.height > 0 else { return false }
        let ra = a.width / a.height
        let rb = b.width / b.height
        return abs(ra - rb) / rb <= tolerance
    }
}
