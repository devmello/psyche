import AppKit
import PsycheHelperCore
import PsycheProtocol

/// One step on screen, as `points.show` delivered it plus what the helper knows about the field.
struct PointsShownStep: Sendable {
    var kind: PointsShowKind
    var note: String
    var value: String?
    var sources: [String]
    var warning: String?
    var n: Int
    var of: Int
    var info: PointsTargetInfo
}

/// Where everything goes for one step: computed apart from any window, so it is testable.
struct PointsOverlayLayout: Equatable {
    var cardRect: CGRect
    var cardDisplay: Int
    /// Displays that carry a pointer layer, with the ring (or chevron) in display-local coordinates.
    var pointerDisplays: [Int]
    var ring: CGRect
    var edge: PointsGeometry.Edge?
}

/// The overlay of one session, on the main actor: two kinds of panel, the session's menu-bar item and
/// the Esc monitor. It draws and listens. It never clicks, types, takes focus or activates anything,
/// and the only things it reports back are the card's button presses and a stop.
@MainActor
final class PointsOverlay {
    @MainActor struct Environment {
        var displays: () -> [PointsDisplay] = { PointsScreens.displays() }
        var increasedContrast: () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast }
        var reduceMotion: () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
        var targetInFront: (pid_t, CGRect?) -> Bool = { pid, frame in
            NSWorkspace.shared.frontmostApplication?.processIdentifier == pid && PointsWindowProbe.isOnScreen(pid: pid, frame: frame)
        }
        var now: () -> Double = { ProcessInfo.processInfo.systemUptime }
        /// Tests build panels and lay them out without ordering anything onto the screen.
        var orderFront = true
        /// Tests skip the menu-bar item, the Esc monitor and the observers.
        var systemHooks = true
    }

    let strings: PointsCardStrings
    let appName: String
    let pid: pid_t
    var onAction: ((PointsCardAction) -> Void)?
    var onStop: (() -> Void)?
    private let env: Environment

    private(set) var cardPanel: PointsCardPanel
    private(set) var pointerPanels: [Int: PointsPointerPanel] = [:]
    private let menuBar = PointsMenuBarItem()
    private var escMonitor: Any?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    private(set) var step: PointsShownStep?
    private var frames: [String: CGRect] = [:]
    private var windowFrame: CGRect?
    private var engineVisible = true
    private var lookOffer = false
    private var dimmer = PointsDimmer()
    private var dimGeneration = 0
    private var cardShown = false
    private var opened = false
    private var lastKey: String?
    private var lastSize: CGSize?

    init(strings: PointsCardStrings, appName: String, pid: pid_t, environment: Environment = Environment()) {
        self.strings = strings
        self.appName = appName
        self.pid = pid
        env = environment
        cardPanel = PointsCardPanel(frame: CGRect(x: 0, y: 0, width: PointsGeometry.cardWidth, height: PointsGeometry.cardMaxHeight))
        cardPanel.cardView.onAction = { [weak self] in self?.onAction?($0) }
        cardPanel.cardView.onHide = { [weak self] in self?.setCollapsed(true) }
        cardPanel.cardView.onRelayout = { [weak self] _ in self?.present() }
    }

    // MARK: Session lifetime

    /// Start: the menu-bar item, the Esc monitor and the observers. No panel is shown until a step is.
    func begin() {
        guard !opened else { return }
        opened = true
        guard env.systemHooks else { return }
        let title = PointsCardText.fill(strings.menuBarTitle, app: appName)
        menuBar.show(title: title, stopTitle: strings.stop) { [weak self] in self?.onStop?() }
        installEscMonitor()
        let ws = NSWorkspace.shared.notificationCenter
        for name in [
            NSWorkspace.didActivateApplicationNotification, NSWorkspace.didDeactivateApplicationNotification,
            NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.didHideApplicationNotification,
            NSWorkspace.didUnhideApplicationNotification,
        ] {
            observe(ws, name)
        }
        observe(NotificationCenter.default, NSApplication.didChangeScreenParametersNotification)
    }

    private func observe(_ center: NotificationCenter, _ name: Foundation.Notification.Name) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.present() }
        }
        observers.append((center, token))
    }

    /// Stop: everything goes, panels are released.
    func close() {
        guard opened else { return }
        opened = false
        for (c, t) in observers { c.removeObserver(t) }
        observers = []
        if let m = escMonitor { NSEvent.removeMonitor(m) }
        escMonitor = nil
        menuBar.remove()
        orderOutAll()
        cardPanel.close()
        for p in pointerPanels.values { p.close() }
        pointerPanels = [:]
        step = nil
    }

    // MARK: Esc

    /// A listen-only global monitor that reads the key code and the modifier bits and nothing else.
    /// Esc still reaches the app: a global monitor can neither swallow nor change an event.
    private func installEscMonitor() {
        let pid = self.pid
        escMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let code = event.keyCode
            let bits = UInt64(event.modifierFlags.rawValue)
            guard PointsKeys.isBareEscape(keyCode: code, modifierBits: bits) else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
                    self?.onStop?()
                }
            }
        }
    }

    var escMonitorInstalled: Bool { escMonitor != nil }
    var menuBarShown: Bool { menuBar.isShown }

    // MARK: Updates

    func show(_ s: PointsShownStep) {
        step = s
        lastKey = nil
        frames = [s.info.fieldId: s.info.frame].compactMapValues { $0 }
        for (id, f) in zip(s.info.nextIds, s.info.nextFrames) { frames[id] = f }
        windowFrame = s.info.windowFrame
        cardPanel.cardView.setCollapsed(false)
        cardPanel.cardView.setStuckOpen(false)
        dimmer.reset()
        present()
    }

    /// Fresh frames after a scroll, a move or a relayout.
    func update(frames new: [String: CGRect], window: CGRect?) {
        for (k, v) in new { frames[k] = v }
        if let window { windowFrame = window }
        present()
    }

    /// Whether the card offers Let Psyche look (sparse tree, page not directions-only).
    func setLookOffer(_ v: Bool) {
        guard v != lookOffer else { return }
        lookOffer = v
        if step != nil { present() }
    }

    func setEngineVisible(_ v: Bool) {
        engineVisible = v
        present()
    }

    func setCollapsed(_ v: Bool) {
        cardPanel.cardView.setCollapsed(v)
        present()
    }

    /// The owner changed the value of the target field: dim the card and let clicks through.
    func typing() {
        dimmer.valueChanged(at: env.now())
        applyDim()
        dimGeneration += 1
        let gen = dimGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + PointsDimmer.restoreAfter + 0.05) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.dimGeneration == gen else { return }
                self.applyDim()
                // A change landed just before the deadline: look again when it is due.
                if let t = self.dimmer.restoreTime(at: self.env.now()) {
                    self.dimGeneration += 1
                    let g = self.dimGeneration
                    DispatchQueue.main.asyncAfter(deadline: .now() + max(0.05, t - self.env.now() + 0.05)) {
                        MainActor.assumeIsolated { if self.dimGeneration == g { self.applyDim() } }
                    }
                }
            }
        }
    }

    var isDimmed: Bool { dimmer.isDimmed(at: env.now()) }

    private func applyDim() {
        let dim = dimmer.isDimmed(at: env.now())
        cardPanel.alphaValue = dim ? PointsDimmer.dimmedAlpha : 1
        cardPanel.ignoresMouseEvents = dim
    }

    // MARK: Layout

    func model(for s: PointsShownStep, edge: PointsGeometry.Edge?) -> PointsCardModel {
        // The field's label comes from the page (an aria-label can say anything): clean it before it is
        // put in a sentence of Psyche's own, and never let it replace the Gateway's note.
        let label = PointsCardText.clean(s.info.label, max: 60)
        var note = s.note
        if note.isEmpty, s.kind == .pointsShowKindSelf {
            note = label.isEmpty ? strings.selfFillPlain : PointsCardText.fill(strings.selfFill, label: label)
        }
        // A scrolled-away field gets a separate hint line; the note stays.
        let hint: String? = edge != nil && !label.isEmpty ? PointsCardText.clean(PointsCardText.fill(strings.scrollTo, label: label), max: 120) : nil
        // A payment button is pressed by the owner: its fixed copy, whatever else came.
        if s.info.role == .button, s.kind == .pointsShowKindSelf { note = strings.payButton }
        // Never a suggestion for a sensitive field, whatever the Gateway sent, and not one that is shaped
        // like a card number, an ID or a secret even if the field was not judged sensitive.
        var suggestion: String? = s.info.sensitive ? nil : s.value
        if let v = suggestion, PointsValueRules.classify(v, label: label) != nil { suggestion = nil }
        if suggestion == nil, s.kind == .fill, !s.info.sensitive { suggestion = strings.unknownValue }
        return PointsCardModel(
            appName: appName, note: PointsCardText.clean(note, max: 300), hint: hint, suggestion: suggestion, warning: s.warning, sources: s.sources,
            stepText: PointsCardText.fill(strings.stepFormat, n: s.n, total: s.of), showNext: s.kind == .nextPage, strings: strings,
            showLook: lookOffer && !s.info.sensitive)
    }

    /// Pure placement for the current step on the given displays.
    func computeLayout(cardSize: CGSize) -> PointsOverlayLayout? {
        guard let s = step, let target = frames[s.info.fieldId] ?? s.info.frame else { return nil }
        let displays = env.displays()
        let edge = windowFrame.flatMap { PointsGeometry.offscreenEdge(target: target, window: $0) }
        // A scrolled-away field: the chevron sits at the window edge, and the card keeps off it.
        var anchor = target
        if let edge, let w = windowFrame {
            let c: CGPoint
            switch edge {
            case .above: c = CGPoint(x: min(max(target.midX, w.minX + 20), w.maxX - 20), y: w.minY + 16)
            case .below: c = CGPoint(x: min(max(target.midX, w.minX + 20), w.maxX - 20), y: w.maxY - 16)
            case .left: c = CGPoint(x: w.minX + 16, y: min(max(target.midY, w.minY + 20), w.maxY - 20))
            case .right: c = CGPoint(x: w.maxX - 16, y: min(max(target.midY, w.minY + 20), w.maxY - 20))
            }
            anchor = CGRect(x: c.x - 12, y: c.y - 12, width: 24, height: 24)
        }
        let next = s.info.nextIds.compactMap { frames[$0] }
        let placement = PointsGeometry.card(size: cardSize, target: anchor, next: next, window: windowFrame, displays: displays)
        let ring = PointsGeometry.ringRect(for: anchor)
        let touching = PointsGeometry.displaysTouching(ring, displays: displays)
        return PointsOverlayLayout(
            cardRect: placement.rect, cardDisplay: placement.displayIndex, pointerDisplays: touching.isEmpty ? [placement.displayIndex] : touching,
            ring: ring, edge: edge)
    }

    /// Lays the step out and shows or hides the panels. Idempotent: called on every event.
    func present() {
        guard opened, let s = step else { return }
        let target = frames[s.info.fieldId] ?? s.info.frame
        let inFront = engineVisible && env.targetInFront(pid, windowFrame)
        guard let target, inFront else {
            orderOutAll()
            return
        }
        let edge = windowFrame.flatMap { PointsGeometry.offscreenEdge(target: target, window: $0) }
        // Rebuild the rows only when the content changed: a scroll must not replace a button under the mouse.
        let m = model(for: s, edge: edge)
        let key = [m.note, m.hint ?? "", m.suggestion ?? "", m.warning ?? "", m.sources.joined(separator: "|"), m.stepText, String(m.showNext),
                   String(cardPanel.cardView.collapsed), String(cardPanel.cardView.stuckOpen)].joined(separator: "\u{1}")
        let size: CGSize
        if key == lastKey, let lastSize {
            size = lastSize
        } else {
            size = cardPanel.cardView.layout(m) { [weak self] in self?.setCollapsed(false) }
            lastKey = key
            lastSize = size
        }
        guard let layout = computeLayout(cardSize: size) else {
            orderOutAll()
            return
        }
        let displays = env.displays()
        let h = PointsScreens.primaryHeight
        // Card.
        cardPanel.cardView.frame = CGRect(origin: .zero, size: size)
        cardPanel.setFrame(PointsGeometry.appKitRect(fromAX: CGRect(origin: layout.cardRect.origin, size: size), primaryHeight: h), display: true)
        // Pointer layers: one per display the field touches, none elsewhere.
        for (i, p) in pointerPanels where !layout.pointerDisplays.contains(i) {
            p.orderOut(nil)
            p.close()
            pointerPanels[i] = nil
        }
        let cardRectAX = CGRect(origin: layout.cardRect.origin, size: size)
        for i in layout.pointerDisplays where displays.indices.contains(i) {
            let d = displays[i]
            let panel = pointerPanels[i] ?? PointsPointerPanel(frame: PointsGeometry.appKitRect(fromAX: d.frame, primaryHeight: h))
            pointerPanels[i] = panel
            panel.setFrame(PointsGeometry.appKitRect(fromAX: d.frame, primaryHeight: h), display: true)
            panel.pointerView.frame = CGRect(origin: .zero, size: d.frame.size)
            func local(_ r: CGRect) -> CGRect { r.offsetBy(dx: -d.frame.minX, dy: -d.frame.minY) }
            var drawing = PointsPointerView.Drawing()
            drawing.ringWidth = PointsGeometry.ringWidth(increasedContrast: env.increasedContrast())
            if let edge = layout.edge {
                drawing.chevron = (edge, CGPoint(x: local(layout.ring).midX, y: local(layout.ring).midY))
            } else {
                drawing.ring = local(layout.ring)
                if layout.cardDisplay == i { drawing.card = local(cardRectAX) }
            }
            panel.pointerView.drawing = drawing
        }
        applyDim()
        guard env.orderFront else { return }
        let first = !cardShown
        for p in pointerPanels.values { p.orderFrontRegardless() }
        cardPanel.orderFrontRegardless()
        cardShown = true
        if first, !env.reduceMotion() { fadeIn() }
    }

    private func fadeIn() {
        let target = cardPanel.alphaValue
        cardPanel.alphaValue = 0
        for p in pointerPanels.values { p.alphaValue = 0 }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.15
            cardPanel.animator().alphaValue = target
            for p in pointerPanels.values { p.animator().alphaValue = 1 }
        }
    }

    private func orderOutAll() {
        cardPanel.orderOut(nil)
        for p in pointerPanels.values { p.orderOut(nil) }
        cardShown = false
        for p in pointerPanels.values { p.alphaValue = 1 }
    }
}
