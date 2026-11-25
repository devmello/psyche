import AppKit
import PsycheHelperCore
import PsycheProtocol

// The two windows of a Psyche points session (docs/design/psyche-points-2026.md §4.1): the pointer
// layer and the note card. Both are non-activating panels that can never become key or main, so
// keyboard focus stays in the form the whole time. Nothing here calls anything that activates the
// helper, takes key status or posts an event (scripts/check-points-boundary.sh).

/// The ink of the UI direction (#2c5aa0).
let pointsInk = NSColor(srgbRed: 0x2c / 255.0, green: 0x5a / 255.0, blue: 0xa0 / 255.0, alpha: 1)

/// The shared window flags. A subclass so `canBecomeKey` and `canBecomeMain` are `false` for good.
@MainActor
class PointsPanel: NSPanel {
    init(frame: CGRect) {
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .floating
        // Over a full-screen app's Space, on every Space, off Cmd-Tab and Mission Control (§4.2).
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        isReleasedWhenClosed = false
        isMovable = false
        animationBehavior = .none
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Borderless and transparent, one per display the field touches. It ignores the mouse entirely.
@MainActor
final class PointsPointerPanel: PointsPanel {
    let pointerView = PointsPointerView(frame: .zero)

    override init(frame: CGRect) {
        super.init(frame: frame)
        ignoresMouseEvents = true
        contentView = pointerView
    }
}

/// The note card. Only its own rectangle takes clicks.
@MainActor
final class PointsCardPanel: PointsPanel {
    let cardView = PointsCardView(frame: .zero)

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView = cardView
    }
}

// MARK: Pointer view

/// Draws the ring around the field, the arrow from the card, or the edge chevron for a field that
/// scrolled out of view. Coordinates are local to the display: AX space minus the display origin,
/// y down (a flipped view).
@MainActor
final class PointsPointerView: NSView {
    struct Drawing {
        /// Ring rect (already padded), nil when the field is not on this display.
        var ring: CGRect?
        var ringWidth: CGFloat = 3
        /// The card, for the arrow.
        var card: CGRect?
        /// A scrolled-away field: a chevron at this edge of the window.
        var chevron: (edge: PointsGeometry.Edge, at: CGPoint)?
    }

    var drawing = Drawing() { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.clear(bounds)
        if let ring = drawing.ring {
            // A pale halo under the ink keeps the ring visible on dark and on ink-colored pages.
            let path = NSBezierPath(roundedRect: ring, xRadius: 6, yRadius: 6)
            NSColor.white.withAlphaComponent(0.85).setStroke()
            path.lineWidth = drawing.ringWidth + 2
            path.stroke()
            pointsInk.setStroke()
            path.lineWidth = drawing.ringWidth
            path.stroke()
            if let card = drawing.card { drawArrow(from: card, to: ring) }
        }
        if let c = drawing.chevron { drawChevron(c.edge, at: c.at) }
    }

    /// A short arrow from the nearest point of the card to the nearest point of the ring.
    private func drawArrow(from card: CGRect, to ring: CGRect) {
        let center = CGPoint(x: ring.midX, y: ring.midY)
        let start = CGPoint(x: min(max(center.x, card.minX), card.maxX), y: min(max(center.y, card.minY), card.maxY))
        let end = CGPoint(x: min(max(start.x, ring.minX), ring.maxX), y: min(max(start.y, ring.minY), ring.maxY))
        let dx = end.x - start.x
        let dy = end.y - start.y
        let len = hypot(dx, dy)
        guard len > 10 else { return }
        let ux = dx / len
        let uy = dy / len
        let line = NSBezierPath()
        line.move(to: start)
        line.line(to: end)
        line.lineWidth = 2
        line.lineCapStyle = .round
        pointsInk.setStroke()
        line.stroke()
        let head = NSBezierPath()
        let size: CGFloat = 8
        head.move(to: end)
        head.line(to: CGPoint(x: end.x - ux * size - uy * size / 2, y: end.y - uy * size + ux * size / 2))
        head.line(to: CGPoint(x: end.x - ux * size + uy * size / 2, y: end.y - uy * size - ux * size / 2))
        head.close()
        pointsInk.setFill()
        head.fill()
    }

    private func drawChevron(_ edge: PointsGeometry.Edge, at p: CGPoint) {
        let s: CGFloat = 9
        let path = NSBezierPath()
        switch edge {
        case .above:
            path.move(to: CGPoint(x: p.x - s, y: p.y + s / 2)); path.line(to: CGPoint(x: p.x, y: p.y - s / 2)); path.line(to: CGPoint(x: p.x + s, y: p.y + s / 2))
        case .below:
            path.move(to: CGPoint(x: p.x - s, y: p.y - s / 2)); path.line(to: CGPoint(x: p.x, y: p.y + s / 2)); path.line(to: CGPoint(x: p.x + s, y: p.y - s / 2))
        case .left:
            path.move(to: CGPoint(x: p.x + s / 2, y: p.y - s)); path.line(to: CGPoint(x: p.x - s / 2, y: p.y)); path.line(to: CGPoint(x: p.x + s / 2, y: p.y + s))
        case .right:
            path.move(to: CGPoint(x: p.x - s / 2, y: p.y - s)); path.line(to: CGPoint(x: p.x + s / 2, y: p.y)); path.line(to: CGPoint(x: p.x - s / 2, y: p.y + s))
        }
        path.lineWidth = 4
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        NSColor.white.withAlphaComponent(0.85).setStroke()
        path.lineWidth = 6
        path.stroke()
        pointsInk.setStroke()
        path.lineWidth = 3.5
        path.stroke()
    }
}

// MARK: Card

/// What the card shows, already filled in and clamped.
struct PointsCardModel {
    var appName: String
    var note: String
    /// A scrolled-away field's scroll-to line, apart from the note.
    var hint: String?
    /// The suggestion, shown as a monospace chip. Never set for a sensitive field.
    var suggestion: String?
    var warning: String?
    var sources: [String]
    var stepText: String
    var showNext: Bool
    var strings: PointsCardStrings?
    /// Offer Let Psyche look: the tree is sparse and the page is not directions-only.
    var showLook = false
    /// Vision mode is on: a small eye shows on the card (§3.1).
    var showVision = false
}

/// A button that works on the first click, without the helper becoming the active app, and that is
/// drawn by hand so the card needs no selector or action wiring.
@MainActor
final class PointsCardButton: NSView {
    let title: String
    var onClick: (() -> Void)?
    var emphasized = false
    private var pressed = false

    init(title: String, emphasized: Bool = false, onClick: @escaping () -> Void) {
        self.title = title
        self.emphasized = emphasized
        self.onClick = onClick
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    required init?(coder: NSCoder) { nil }

    static let font = NSFont.systemFont(ofSize: 11, weight: .medium)

    static func width(_ title: String) -> CGFloat {
        ceil((title as NSString).size(withAttributes: [.font: font]).width) + 16
    }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        pressed = true
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        let fire = pressed && inside
        pressed = false
        needsDisplay = true
        if fire { onClick?() }
    }

    override func accessibilityPerformPress() -> Bool {
        onClick?()
        return true
    }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: r, xRadius: 5, yRadius: 5)
        let fill: NSColor = emphasized ? pointsInk : NSColor.labelColor.withAlphaComponent(pressed ? 0.14 : 0.06)
        fill.setFill()
        path.fill()
        let color: NSColor = emphasized ? .white : .labelColor
        let attrs: [NSAttributedString.Key: Any] = [.font: Self.font, .foregroundColor: color]
        let size = (title as NSString).size(withAttributes: attrs)
        (title as NSString).draw(at: CGPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2), withAttributes: attrs)
    }
}

/// The note card: an opaque rounded surface (no glass), rows laid out by hand.
@MainActor
final class PointsCardView: NSView {
    static let padding: CGFloat = 12
    static let rowGap: CGFloat = 6

    var onAction: ((PointsCardAction) -> Void)?
    var onHide: (() -> Void)?
    private(set) var collapsed = false
    private(set) var stuckOpen = false
    private var model: PointsCardModel?

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        NSColor.windowBackgroundColor.setFill()
        path.fill()
        NSColor.separatorColor.setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    func setCollapsed(_ v: Bool) { collapsed = v }
    func setStuckOpen(_ v: Bool) { stuckOpen = v }

    /// Rebuilds the rows for `model` and returns the size the card needs: 300 wide, at most 160 high
    /// (the note gives up lines before the card grows past that), or a small pill when collapsed.
    @discardableResult
    func layout(_ model: PointsCardModel, onExpand: @escaping () -> Void) -> CGSize {
        self.model = model
        subviews.forEach { $0.removeFromSuperview() }
        if collapsed {
            let b = PointsCardButton(title: model.stepText, emphasized: true, onClick: onExpand)
            let w = max(PointsCardButton.width(model.stepText), 44)
            b.frame = CGRect(x: 0, y: 0, width: w, height: 26)
            addSubview(b)
            return CGSize(width: w, height: 26)
        }
        var maxNoteLines = 3
        while true {
            let h = build(model, noteLines: maxNoteLines)
            if h <= PointsGeometry.cardMaxHeight || maxNoteLines == 1 {
                return CGSize(width: PointsGeometry.cardWidth, height: min(h, PointsGeometry.cardMaxHeight))
            }
            maxNoteLines -= 1
        }
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor, lines: Int = 1, width: CGFloat) -> NSTextField {
        let f = NSTextField(wrappingLabelWithString: text)
        f.font = NSFont.systemFont(ofSize: size, weight: weight)
        f.textColor = color
        f.maximumNumberOfLines = lines
        f.lineBreakMode = .byTruncatingTail
        f.isSelectable = false
        f.allowsDefaultTighteningForTruncation = true
        let lineH = ceil(f.font!.boundingRectForFont.height)
        let measured = f.sizeThatFits(NSSize(width: width, height: .greatestFiniteMagnitude)).height
        f.frame = CGRect(x: 0, y: 0, width: width, height: min(ceil(measured), lineH * CGFloat(lines)))
        return f
    }

    /// Lays the rows out and returns the content height.
    private func build(_ m: PointsCardModel, noteLines: Int) -> CGFloat {
        subviews.forEach { $0.removeFromSuperview() }
        let pad = Self.padding
        let w = PointsGeometry.cardWidth - 2 * pad
        var y = pad
        func place(_ v: NSView, x: CGFloat = pad) {
            v.frame.origin = CGPoint(x: x, y: y)
            addSubview(v)
            y += v.frame.height + Self.rowGap
        }
        // 1. the app chip, and Hide note on the right
        let app = label(m.appName, size: 11, weight: .semibold, color: .secondaryLabelColor, width: w - 90)
        app.frame.origin = CGPoint(x: pad, y: y + 3)
        addSubview(app)
        if let s = m.strings {
            let hide = PointsCardButton(title: s.hideNote, onClick: { [weak self] in self?.onHide?() })
            let hw = min(PointsCardButton.width(s.hideNote), 100)
            hide.frame = CGRect(x: PointsGeometry.cardWidth - pad - hw, y: y, width: hw, height: 20)
            addSubview(hide)
            if m.showVision {
                let eye = PointsEyeBadge(accessibilityText: s.visionBadge)
                eye.frame = CGRect(x: PointsGeometry.cardWidth - pad - hw - 22, y: y + 2, width: 16, height: 16)
                addSubview(eye)
            }
        }
        y += 20 + Self.rowGap
        if let h = m.hint, !h.isEmpty { place(label(h, size: 11, weight: .medium, color: pointsInk, lines: 1, width: w)) }
        // 2. the note
        place(label(m.note, size: 13, lines: noteLines, width: w))
        // 3. the suggestion, as a monospace chip (no Copy here: see PointsCapabilities)
        if let value = m.suggestion, !value.isEmpty {
            let chip = NSTextField(labelWithString: value)
            chip.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            chip.lineBreakMode = .byTruncatingMiddle
            chip.isSelectable = false
            chip.wantsLayer = true
            chip.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.07).cgColor
            chip.layer?.cornerRadius = 5
            chip.frame = CGRect(x: 0, y: 0, width: w, height: 22)
            place(chip)
        }
        if let warn = m.warning, !warn.isEmpty { place(label(warn, size: 11, color: .secondaryLabelColor, lines: 2, width: w)) }
        // 4. the sources and 5. the step count share a line
        let src = m.sources.joined(separator: " · ")
        let step = label(m.stepText, size: 11, color: .secondaryLabelColor, width: 60)
        step.alignment = .right
        let srcLabel = label(src, size: 11, color: .secondaryLabelColor, width: w - 66)
        srcLabel.frame.origin = CGPoint(x: pad, y: y)
        step.frame.origin = CGPoint(x: PointsGeometry.cardWidth - pad - 60, y: y)
        if !src.isEmpty { addSubview(srcLabel) }
        addSubview(step)
        y += max(step.frame.height, 14) + Self.rowGap
        // 6. the buttons, flowing onto as many rows as the strings need
        if let s = m.strings {
            var items: [(String, PointsCardAction?, Bool)] = []
            if stuckOpen {
                items = [(s.stuck, nil, true), (s.stuckMissing, .stuckMissing, false), (s.stuckUnclear, .stuckUnclear, false), (s.stuckBlocked, .stuckBlocked, false)]
            } else {
                items = [(s.back, .back, false)]
                if m.showNext { items.append((s.next, .next, true)) }
                if m.showLook { items.append((s.letLook, .look, false)) }
                items += [(s.skip, .skip, false), (s.looksWrong, .wrong, false), (s.stuck, nil, false), (s.askInPsyche, .ask, false), (s.stop, .stop, false)]
            }
            var x = pad
            var rowTop = y
            for (title, action, emph) in items {
                let bw = min(PointsCardButton.width(title), w)
                if x + bw > PointsGeometry.cardWidth - pad, x > pad {
                    x = pad
                    rowTop += 20 + 4
                }
                let b = PointsCardButton(title: title, emphasized: emph) { [weak self] in
                    guard let self else { return }
                    if let action {
                        self.stuckOpen = false
                        self.onAction?(action)
                    } else {
                        self.stuckOpen.toggle()
                        if let m = self.model { self.onRelayout?(m) }
                    }
                }
                b.frame = CGRect(x: x, y: rowTop, width: bw, height: 20)
                addSubview(b)
                x += bw + 4
            }
            y = rowTop + 20 + Self.rowGap
        }
        return y - Self.rowGap + pad
    }

    /// Set by the overlay: the Stuck? toggle changes which buttons show, so the card is laid out again.
    var onRelayout: ((PointsCardModel) -> Void)?
}


/// The eye that shows while vision mode is on: an SF Symbol drawn by hand, read aloud with the Gateway's
/// `visionBadge` string. It takes no clicks.
@MainActor
final class PointsEyeBadge: NSView {
    init(accessibilityText: String) {
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel(accessibilityText)
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let img = NSImage(systemSymbolName: "eye", accessibilityDescription: nil) else { return }
        let tinted = img.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)) ?? img
        tinted.isTemplate = true
        NSColor.secondaryLabelColor.set()
        let r = bounds.insetBy(dx: 1, dy: 2)
        tinted.draw(in: r, from: .zero, operation: .sourceOver, fraction: 0.9)
    }
}
