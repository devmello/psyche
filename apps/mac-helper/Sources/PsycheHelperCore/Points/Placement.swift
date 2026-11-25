import CoreGraphics
import Foundation

// The pure maths of the Psyche points overlay (docs/design/psyche-points-2026.md §4.1, §4.2): where
// the note card goes, which displays carry a pointer layer, the AX to AppKit coordinate flip, the
// typing dim, the card text with its placeholders. Nothing here touches AppKit, so every rule is
// unit-tested without a window server.
//
// All rectangles are in AX space: global, top-left origin, points. Retina is a matter of snapping
// to the backing scale, never of changing units.

/// One display, in AX space.
public struct PointsDisplay: Sendable, Equatable {
    /// The whole display.
    public var frame: CGRect
    /// The part not covered by the menu bar and the Dock: the card stays inside it.
    public var visible: CGRect
    /// Backing scale factor (2 on a Retina display).
    public var scale: CGFloat

    public init(frame: CGRect, visible: CGRect? = nil, scale: CGFloat = 1) {
        self.frame = frame
        self.visible = visible ?? frame
        self.scale = scale
    }
}

public enum PointsCardSide: String, Sendable, Equatable {
    case windowRight, windowLeft, displayRight, displayLeft, below, above, free, forced
}

public struct PointsCardPlacement: Sendable, Equatable {
    public var rect: CGRect
    /// Index into the displays passed in: the display that holds the field.
    public var displayIndex: Int
    public var side: PointsCardSide
    /// False only when no spot on the display avoids the target and the next fields (a field that
    /// fills the screen). The card then keeps off the target first and the next fields second.
    public var clear: Bool
}

public enum PointsGeometry {
    public static let cardWidth: CGFloat = 300
    public static let cardMaxHeight: CGFloat = 160
    /// The ring sits this far outside the field's frame (§4.1).
    public static let ringPadding: CGFloat = 4
    /// The card keeps this far from the field: ring padding, half the thickest stroke, a little air.
    public static let targetClearance: CGFloat = 12
    public static let nextClearance: CGFloat = 4
    /// Gap between the window (or a display edge) and the card.
    public static let gap: CGFloat = 12
    static let step: CGFloat = 16

    public static func ringRect(for target: CGRect) -> CGRect { target.insetBy(dx: -ringPadding, dy: -ringPadding) }

    /// 3 pt ink ring, 5 pt with Increase Contrast.
    public static func ringWidth(increasedContrast: Bool) -> CGFloat { increasedContrast ? 5 : 3 }

    // MARK: Card placement

    /// The spot for the card. It never overlaps the target field or the next two planned fields when any
    /// spot on the field's display avoids them. Preference: the window's side margin (right, then left),
    /// the display edge outside the window, just under or over the field, then any free spot.
    public static func card(
        size: CGSize, target: CGRect, next: [CGRect], window: CGRect?, displays: [PointsDisplay]
    ) -> PointsCardPlacement {
        let list = displays.isEmpty ? [PointsDisplay(frame: target.insetBy(dx: -4000, dy: -4000))] : displays
        let di = displayIndex(for: target, displays: list)
        let display = list[di]
        let region = display.visible
        // A card taller or wider than the display is cut to it.
        let size = CGSize(width: min(size.width, region.width), height: min(size.height, region.height))
        let keepOut = target.insetBy(dx: -targetClearance, dy: -targetClearance)
        let avoid = [keepOut] + next.prefix(2).map { $0.insetBy(dx: -nextClearance, dy: -nextClearance) }

        func fits(_ r: CGRect) -> Bool {
            r.minX >= region.minX && r.minY >= region.minY && r.maxX <= region.maxX && r.maxY <= region.maxY
                && !avoid.contains { $0.intersects(r) }
        }
        func done(_ r: CGRect, _ side: PointsCardSide, clear: Bool = true) -> PointsCardPlacement {
            PointsCardPlacement(rect: snap(r, scale: display.scale), displayIndex: di, side: side, clear: clear)
        }

        // Columns: a fixed x, slide y from the field's own height outwards.
        var columns: [(CGFloat, PointsCardSide)] = []
        if let w = window {
            columns.append((w.maxX + gap, .windowRight))
            columns.append((w.minX - gap - size.width, .windowLeft))
        }
        columns.append((region.maxX - size.width - gap, .displayRight))
        columns.append((region.minX + gap, .displayLeft))
        let y0 = min(max(target.midY - size.height / 2, region.minY), region.maxY - size.height)
        for (x, side) in columns {
            for y in slide(from: y0, low: region.minY, high: region.maxY - size.height) {
                let r = CGRect(x: x, y: y, width: size.width, height: size.height)
                if fits(r) { return done(r, side) }
            }
        }
        // Rows: just under, then just over the field, sliding x.
        let x0 = min(max(target.minX, region.minX), region.maxX - size.width)
        let rows: [(CGFloat, PointsCardSide)] = [(keepOut.maxY + 1, .below), (keepOut.minY - 1 - size.height, .above)]
        for (y, side) in rows {
            for x in slide(from: x0, low: region.minX, high: region.maxX - size.width) {
                let r = CGRect(x: x, y: y, width: size.width, height: size.height)
                if fits(r) { return done(r, side) }
            }
        }
        // Any free spot on the grid, nearest to the field first.
        var best: (CGRect, CGFloat)?
        var y = region.minY
        while y + size.height <= region.maxY {
            var x = region.minX
            while x + size.width <= region.maxX {
                let r = CGRect(x: x, y: y, width: size.width, height: size.height)
                if fits(r) {
                    let d = hypot(r.midX - target.midX, r.midY - target.midY)
                    if best == nil || d < best!.1 { best = (r, d) }
                }
                x += step
            }
            y += step
        }
        if let (r, _) = best { return done(r, .free) }
        // Nothing is free (the field fills the display): keep off the target before the next fields.
        var worst: (CGRect, CGFloat)?
        y = region.minY
        while y + size.height <= region.maxY {
            var x = region.minX
            while x + size.width <= region.maxX {
                let r = CGRect(x: x, y: y, width: size.width, height: size.height)
                let cost = area(r.intersection(target)) * 1000 + next.prefix(2).reduce(0) { $0 + area(r.intersection($1)) }
                if worst == nil || cost < worst!.1 { worst = (r, cost) }
                x += step
            }
            y += step
        }
        let r = worst?.0 ?? CGRect(origin: region.origin, size: size)
        return done(r, .forced, clear: false)
    }

    /// `start`, then alternately below and above it in `step`s, inside [low, high].
    static func slide(from start: CGFloat, low: CGFloat, high: CGFloat) -> [CGFloat] {
        var out = [start]
        var k: CGFloat = 1
        while start - k * step >= low || start + k * step <= high {
            if start + k * step <= high { out.append(start + k * step) }
            if start - k * step >= low { out.append(start - k * step) }
            k += 1
        }
        return out
    }

    private static func area(_ r: CGRect) -> CGFloat { r.isNull ? 0 : r.width * r.height }

    // MARK: Displays

    /// The display holding most of the rect (the nearest one when it lies in a gap).
    public static func displayIndex(for rect: CGRect, displays: [PointsDisplay]) -> Int {
        var best = 0
        var bestArea: CGFloat = -1
        for (i, d) in displays.enumerated() {
            let a = area(d.frame.intersection(rect))
            if a > bestArea { best = i; bestArea = a }
        }
        if bestArea > 0 { return best }
        let c = CGPoint(x: rect.midX, y: rect.midY)
        var nearest = 0
        var nearestDist = CGFloat.greatestFiniteMagnitude
        for (i, d) in displays.enumerated() {
            let dx = max(d.frame.minX - c.x, 0, c.x - d.frame.maxX)
            let dy = max(d.frame.minY - c.y, 0, c.y - d.frame.maxY)
            if hypot(dx, dy) < nearestDist { nearest = i; nearestDist = hypot(dx, dy) }
        }
        return nearest
    }

    /// Every display the rect touches (the pointer layer goes on each, §4.2), in order.
    public static func displaysTouching(_ rect: CGRect, displays: [PointsDisplay]) -> [Int] {
        displays.indices.filter { displays[$0].frame.intersects(rect) }
    }

    /// Origin rounded to the display's pixel grid, so a Retina card is not drawn on half pixels.
    public static func snap(_ r: CGRect, scale: CGFloat) -> CGRect {
        guard scale > 0 else { return r }
        return CGRect(x: (r.minX * scale).rounded() / scale, y: (r.minY * scale).rounded() / scale, width: r.width, height: r.height)
    }

    // MARK: Out of view

    public enum Edge: String, Sendable, Equatable { case above, below, left, right }

    /// The edge of the window a scrolled-away field lies beyond (it gets a chevron, §4.1); nil while any
    /// part of the field is inside the window. Vertical wins on a diagonal: pages scroll vertically.
    public static func offscreenEdge(target: CGRect, window: CGRect) -> Edge? {
        if target.intersects(window) { return nil }
        if target.maxY <= window.minY { return .above }
        if target.minY >= window.maxY { return .below }
        return target.maxX <= window.minX ? .left : .right
    }

    // MARK: AX space and AppKit space

    /// AX (top-left origin, y down) to AppKit (bottom-left origin of the primary display, y up).
    /// `primaryHeight` is the height of the primary display (the one with the menu bar).
    public static func appKitRect(fromAX r: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    public static func axRect(fromAppKit r: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// Whether a listed on-screen window (CGWindowList bounds, same space as AX) is the target window.
    /// AX and the window list round differently, so a few points of slack.
    public static func sameWindow(_ ax: CGRect, _ listed: CGRect, slack: CGFloat = 3) -> Bool {
        abs(ax.minX - listed.minX) <= slack && abs(ax.minY - listed.minY) <= slack
            && abs(ax.width - listed.width) <= slack && abs(ax.height - listed.height) <= slack
    }
}

/// The card dims to 40% and lets clicks through while the owner types in the target field, and comes
/// back 1 s after the last value change (§4.1). Pure: the caller supplies the clock.
public struct PointsDimmer: Sendable, Equatable {
    public static let dimmedAlpha: Double = 0.4
    public static let restoreAfter: Double = 1.0
    private var lastChange: Double?

    public init() {}

    public mutating func valueChanged(at now: Double) { lastChange = now }
    public mutating func reset() { lastChange = nil }

    public func isDimmed(at now: Double) -> Bool {
        guard let t = lastChange else { return false }
        return now - t < Self.restoreAfter
    }

    /// When to look again (nil while not dimmed).
    public func restoreTime(at now: Double) -> Double? {
        guard isDimmed(at: now), let t = lastChange else { return nil }
        return t + Self.restoreAfter
    }
}

/// Card text: placeholders and the helper's own clamp of what the Gateway sends (§8: "the helper
/// clamps lengths again"). The helper holds no English: the strings come from the Gateway.
public enum PointsCardText {
    /// Fills `{label}`, `{app}`, `{n}` and `{total}` in one pass, so a value that itself contains
    /// "{n}" is not expanded again. Unknown placeholders stay as written.
    public static func fill(_ template: String, label: String? = nil, app: String? = nil, n: Int? = nil, total: Int? = nil) -> String {
        var values: [String: String] = [:]
        if let label { values["label"] = label }
        if let app { values["app"] = app }
        if let n { values["n"] = String(n) }
        if let total { values["total"] = String(total) }
        var out = ""
        var i = template.startIndex
        while i < template.endIndex {
            if template[i] == "{", let close = template[i...].firstIndex(of: "}") {
                let key = String(template[template.index(after: i)..<close])
                if let v = values[key] {
                    out += v
                    i = template.index(after: close)
                    continue
                }
            }
            out.append(template[i])
            i = template.index(after: i)
        }
        return out
    }

    /// One line of card text: control, format (bidi) and line characters dropped, whitespace
    /// collapsed, at most `max` characters.
    public static func clean(_ s: String, max: Int) -> String {
        var scalars = String.UnicodeScalarView()
        for u in s.unicodeScalars {
            if u == "\n" || u == "\t" || u == "\r" {
                scalars.append(" ")
                continue
            }
            switch u.properties.generalCategory {
            // The joiners stay: emoji sequences and some scripts need them, and they reorder nothing.
            case .format where u == "\u{200D}" || u == "\u{200C}": scalars.append(u)
            case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned: continue
            default: scalars.append(u)
            }
        }
        let collapsed = String(scalars).split(whereSeparator: { $0 == " " }).joined(separator: " ")
        return String(collapsed.prefix(max))
    }
}

/// The Esc stop (§4.2): a bare Esc only. The overlay's monitor reads `keyCode` and the modifier
/// bits, never the characters typed.
public enum PointsKeys {
    public static let escapeKeyCode: UInt16 = 53
    /// Shift, Control, Option and Command (the same bits in NSEvent.ModifierFlags and CGEventFlags).
    /// Caps Lock, the numeric-pad flag and Fn do not count as a modifier.
    public static let modifierMask: UInt64 = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)

    public static func isBareEscape(keyCode: UInt16, modifierBits: UInt64) -> Bool {
        keyCode == escapeKeyCode && modifierBits & modifierMask == 0
    }
}
