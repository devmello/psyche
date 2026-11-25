import AppKit
import PsycheHelperCore

/// The session's menu-bar item: "◉ Pointing: {app}" with Stop (§4.2). It exists only while a session
/// runs. The Stop row is a custom view that reacts to the mouse, so no selector or target is wired
/// (the Points boundary check bans Objective-C exposure); Esc and the card's Stop are the other ways out.
@MainActor
final class PointsMenuBarItem {
    private var item: NSStatusItem?

    func show(title: String, stopTitle: String, onStop: @escaping () -> Void) {
        remove()
        let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = title
        status.button?.setAccessibilityLabel(title)
        let menu = NSMenu()
        let header = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        let stop = NSMenuItem()
        stop.view = PointsMenuStopView(title: stopTitle, onStop: onStop)
        menu.addItem(stop)
        status.menu = menu
        item = status
    }

    func remove() {
        if let item { NSStatusBar.system.removeStatusItem(item) }
        item = nil
    }

    var isShown: Bool { item != nil }
}

@MainActor
final class PointsMenuStopView: NSView {
    private let title: String
    private let onStop: () -> Void
    private var hovering = false

    init(title: String, onStop: @escaping () -> Void) {
        self.title = title
        self.onStop = onStop
        let w = max(180, ceil((title as NSString).size(withAttributes: [.font: NSFont.menuFont(ofSize: 0)]).width) + 36)
        super.init(frame: CGRect(x: 0, y: 0, width: w, height: 22))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { nil }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseUp(with event: NSEvent) {
        enclosingMenuItem?.menu?.cancelTracking()
        onStop()
    }

    override func accessibilityPerformPress() -> Bool {
        enclosingMenuItem?.menu?.cancelTracking()
        onStop()
        return true
    }

    override func draw(_ dirtyRect: NSRect) {
        if hovering {
            NSColor.selectedContentBackgroundColor.setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 4, dy: 0), xRadius: 4, yRadius: 4).fill()
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.menuFont(ofSize: 0),
            .foregroundColor: hovering ? NSColor.selectedMenuItemTextColor : NSColor.labelColor,
        ]
        let size = (title as NSString).size(withAttributes: attrs)
        (title as NSString).draw(at: CGPoint(x: 14, y: (bounds.height - size.height) / 2), withAttributes: attrs)
    }
}
