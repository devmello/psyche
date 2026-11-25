import CoreGraphics
import Foundation

/// Paints solid rectangles over a captured frame before it is encoded (docs/design/psyche-points-2026.md
/// §5.2: every known sensitive field's frame is painted solid before the picture leaves the helper).
/// Pure CoreGraphics on an image already in memory: no capture, no permission, no event, no file.
public enum ImageMask {
    /// A copy of `image` with each of `rects` filled opaque black. `rects` are in pixels with the origin
    /// at the TOP-left of the image. Nil when no bitmap context can be made (the caller refuses the look:
    /// an unmasked picture is never returned).
    public static func paint(_ image: CGImage, rects: [CGRect]) -> CGImage? {
        let w = image.width
        let h = image.height
        guard w > 0, h > 0, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        guard
            let ctx = CGContext(
                data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.interpolationQuality = .none
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
        for r in rects {
            guard r.origin.x.isFinite, r.origin.y.isFinite, r.width.isFinite, r.height.isFinite else { return nil }
            let x0 = max(0, floor(r.minX))
            let x1 = min(CGFloat(w), ceil(r.maxX))
            let top = max(0, floor(r.minY))
            let bottom = min(CGFloat(h), ceil(r.maxY))
            if x1 <= x0 || bottom <= top { continue }
            // CoreGraphics puts the origin at the bottom-left.
            ctx.fill(CGRect(x: x0, y: CGFloat(h) - bottom, width: x1 - x0, height: bottom - top))
        }
        return ctx.makeImage()
    }
}
