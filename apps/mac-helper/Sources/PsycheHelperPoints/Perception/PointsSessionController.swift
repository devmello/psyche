import AppKit
import ApplicationServices
import Foundation
import PsycheAXRead
import PsycheHelperCore
import PsycheProtocol

/// One Points session's perception: an `AXObserver` on one process, one dedicated thread that blocks
/// in `CFRunLoopRun()` (no timed wakeups, and not `RunLoopThread`, which wakes four times a second),
/// the notification table of docs/design/psyche-points-2026.md §3.2, the listen-only scroll monitor,
/// and the `PointsEngine` that decides what to read and what to send.
///
/// Everything that touches the engine runs on that thread: AX callbacks, the one-shot timer for the
/// next debounce deadline, and blocks other threads marshal with `perform`. The timer is set only
/// while work is pending, so an idle session has no wakeups. The thread reads and listens; it never
/// sets, performs or posts anything (`scripts/check-points-boundary.sh`).
final class PointsSessionController: @unchecked Sendable {
    static let appNotifications = [
        kAXFocusedUIElementChangedNotification, kAXApplicationActivatedNotification, kAXApplicationDeactivatedNotification,
        kAXApplicationHiddenNotification, kAXApplicationShownNotification,
    ]
    static let windowNotifications = [
        kAXUIElementDestroyedNotification, kAXTitleChangedNotification, kAXLayoutChangedNotification, kAXMovedNotification,
        kAXResizedNotification, kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification,
    ]
    static let webAreaNotifications = ["AXLoadComplete", kAXLayoutChangedNotification, kAXTitleChangedNotification]
    static let focusedNotifications = [kAXValueChangedNotification, kAXUIElementDestroyedNotification]

    let sessionId: String
    let pid: pid_t
    let bundleId: String
    let events: AsyncStream<PointsSessionEvent>

    private let source: LivePointsSource
    private let engine: PointsEngine<LivePointsSource>
    private let continuation: AsyncStream<PointsSessionEvent>.Continuation
    private let launchDate: Date?
    private let teamId: String?
    private let lock = NSLock()
    private var loop: CFRunLoop?
    private var observer: AXObserver?
    private var timer: CFRunLoopTimer?
    private var watchedField: AXUIElement?
    private var webArea: AXUIElement?
    private var terminationObserver: NSObjectProtocol?
    private var scrollMonitor: Any?
    private var lastScroll: Double = 0
    private var watching = false
    private var lastIdentityCheck: Double = 0
    private var started = false
    private var stopped = false
    private let exited = DispatchSemaphore(value: 0)
    /// Set once the stream is finished: nothing is yielded after it (stop does not wait on the observer thread).
    private let closedGate: LockedFlag
    /// The overlay (W4): panels, menu-bar item and Esc monitor, all on the main queue.
    private let overlay: PointsOverlayHost
    /// The field the card points at, so a value change there dims the card.
    private var shownTarget: String?
    /// Vision mode (§3.1): on after a look, off when a page has a usable tree again.
    private let vision: LockedFlag
    private let tokens: PointsActionTokens
    private var looker: PointsLooker!
    /// The last look, to map a box the model drew on it (guarded by `lock`).
    private var lastLook: PointsLookRecord?

    init(
        sessionId: String, app: NSRunningApplication, window: AXUIElement, target: PointsTarget, teamId: String?, strings: PointsCardStrings,
        lookEnvironment: PointsLookEnvironment = .live, tokens: PointsActionTokens = PointsActionTokens()
    ) {
        self.sessionId = sessionId
        pid = app.processIdentifier
        bundleId = target.bundleId
        launchDate = app.launchDate
        self.teamId = teamId
        source = LivePointsSource(window: window, pid: app.processIdentifier)
        var cont: AsyncStream<PointsSessionEvent>.Continuation!
        events = AsyncStream(bufferingPolicy: .unbounded) { cont = $0 }
        continuation = cont
        let c = cont!
        let closed = LockedFlag()
        closedGate = closed
        let visionFlag = LockedFlag()
        vision = visionFlag
        self.tokens = tokens
        let host = PointsOverlayHost(strings: strings, appName: target.appName, pid: app.processIdentifier)
        overlay = host
        engine = PointsEngine(source: source, target: target) { event in
            if !closed.isSet { c.yield(event) }
            if event.type == .visible, let v = event.visible { host.setEngineVisible(v) }
            // A page with a usable tree ends vision mode (§3.1): three or more fillable fields.
            if event.type == .digest, let d = event.digest, d.fields.filter({ $0.role != .link && $0.role != .button }).count >= 3 { visionFlag.clear() }
        }
        // Frames of the fields the card keeps off, after a scroll, a move or a relayout.
        engine.onFrames = { [weak self] frames in
            guard let self else { return }
            self.overlay.frames(frames, window: self.engine.windowFrame())
        }
        host.bind(
            onAction: { [weak self] a in self?.cardAction(a) },
            onStop: { [weak self] in self?.cardAction(.stop) })
        looker = PointsLooker(
            pid: app.processIdentifier, bundleId: target.bundleId, tokens: tokens, environment: lookEnvironment,
            maskFrames: { [weak self] in await self?.maskFrames() ?? PointsMaskFrames(window: nil, frames: [], complete: false) })
    }

    static func now() -> Double { ProcessInfo.processInfo.systemUptime }

    // MARK: Start and stop

    /// Starts the observer thread; false if it did not come up (the session never started).
    func start() -> Bool {
        let ready = DispatchSemaphore(value: 0)
        let ok = LockedFlag()
        let t = Thread { [self] in
            let run = CFRunLoopGetCurrent()!
            let early = lock.withLock { () -> Bool in loop = run; return stopped }
            if early {  // stopped before the loop existed (7a)
                ready.signal()
                finish()
                return
            }
            guard install(run) else {
                ready.signal()
                finish()
                return
            }
            ok.set()
            engine.begin(at: Self.now())
            afterWork()
            ready.signal()
            CFRunLoopRun()
            teardown(run)
            finish()
        }
        t.name = "com.psyche.helper.points-ax"
        t.qualityOfService = .userInitiated
        t.start()
        guard ready.wait(timeout: .now() + 5) == .success, ok.isSet else {
            stop(.error)
            return false
        }
        lock.withLock { started = true }
        installScrollMonitor()
        overlay.begin()
        return true
    }

    private func finish() {
        removeScrollMonitor()
        overlay.close()
        if closedGate.testAndSet() { continuation.finish() }
        exited.signal()
    }

    /// Ends the session from any thread. The `ended` event goes out once, then the stream finishes.
    func stop(_ reason: PointsEndReason) {
        let run: CFRunLoop? = lock.withLock {
            if stopped { return nil }
            stopped = true
            return loop
        }
        // The overlay goes now too, not when the observer thread gets round to it: a hung app read must not
        // leave a ghost card or a menu-bar item after Stop. Idempotent.
        overlay.close()
        // End the stream here, on the caller's thread: a hung app must not keep the session slot or
        // computer use locked out. The observer thread (if it is alive) only tears its watches down.
        if closedGate.testAndSet() {
            continuation.yield(PointsSessionEvent(reason: reason, type: .ended))
            continuation.finish()
        }
        guard let run else { return }
        perform(on: run) { [self] in
            engine.end(reason)
            CFRunLoopStop(CFRunLoopGetCurrent())
        }
    }

    // MARK: Overlay (W4)

    /// A card button, the menu-bar item or Esc. The Gateway sees the action; Stop also ends the session here,
    /// so the owner is never left with a card whose session is gone.
    func cardAction(_ action: PointsCardAction) {
        if closedGate.isSet { return }
        // The owner's Let Psyche look press (and Next while vision mode is on) mints the one id a look answers to.
        let actionId: String? = (action == .look || (action == .next && vision.isSet)) ? tokens.issue() : nil
        continuation.yield(PointsSessionEvent(action: action, actionID: actionId, type: .action))
        if action == .stop { stop(.stop) }
    }

    /// `points.show`: reads the field's fresh frame on the observer thread, then hands the step to the
    /// overlay. False when the target is not on screen right now (it appears when it is).
    func show(_ p: PointsShowParams, fieldId: String) async throws -> Bool {
        let run: CFRunLoop? = lock.withLock { stopped ? nil : loop }
        guard let run else { throw CapabilityError(.notFound, reason: "session_ended", "That session is over") }
        let info: PointsTargetInfo? = await withCheckedContinuation { (cont: CheckedContinuation<PointsTargetInfo?, Never>) in
            let once = ResumeOnce(cont)
            perform(on: run) { [self] in
                let i = engine.targetInfo(for: fieldId)
                if let i { engine.setWatched([fieldId] + i.nextIds) }
                once.resume(i)
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { once.resume(nil) }
        }
        guard let info else { throw CapabilityError(.notFound, reason: "field_gone", "That field is not on the page any more") }
        lock.withLock { shownTarget = fieldId }
        overlay.show(Self.step(p, info: info))
        return info.frame != nil
    }

    private static func step(_ p: PointsShowParams, info: PointsTargetInfo) -> PointsShownStep {
        PointsShownStep(
            kind: p.kind, note: PointsCardText.clean(p.note, max: 300), value: p.value.map { PointsCardText.clean($0, max: 200) },
            sources: (p.sources ?? []).prefix(3).map { PointsCardText.clean($0, max: 60) }.filter { !$0.isEmpty },
            warning: p.warning.map { PointsCardText.clean($0, max: 200) }, n: max(1, p.step.n), of: max(1, p.step.of), info: info)
    }

    // MARK: Vision mode (W5)

    /// `points.look`: one picture of the target window, masked, for the owner's latest look press.
    func look(actionId: String) async throws -> PointsLookResult {
        if lock.withLock({ stopped }) { throw CapabilityError(.notFound, reason: "session_ended", "That session is over") }
        let outcome = try await looker.look(actionId: actionId)
        lock.withLock { lastLook = outcome.record }
        vision.set()
        return outcome.result
    }

    /// The frames to paint over, read on the observer thread (never a value).
    fileprivate func maskFrames() async -> PointsMaskFrames {
        let none = PointsMaskFrames(window: nil, frames: [], complete: false)
        let run: CFRunLoop? = lock.withLock { stopped ? nil : loop }
        guard let run else { return none }
        return await withCheckedContinuation { (cont: CheckedContinuation<PointsMaskFrames, Never>) in
            let once = ResumeOnce(cont)
            perform(on: run) { [self] in once.resume(engine.maskFrames(at: Self.now())) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { once.resume(none) }
        }
    }

    private func currentWindowFrame() async -> CGRect? {
        let run: CFRunLoop? = lock.withLock { stopped ? nil : loop }
        guard let run else { return nil }
        return await withCheckedContinuation { (cont: CheckedContinuation<CGRect?, Never>) in
            let once = ResumeOnce(cont)
            perform(on: run) { [self] in once.resume(engine.windowFrame()) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { once.resume(nil) }
        }
    }

    /// `points.show` for a box drawn on the last picture: mapped to the screen, cut to the window and the
    /// displays. A box that touches a painted (sensitive) frame gets no suggested value.
    func showBox(_ p: PointsShowParams) async throws -> Bool {
        if lock.withLock({ stopped }) { throw CapabilityError(.notFound, reason: "session_ended", "That session is over") }
        guard let r = p.target.box, let isz = p.target.imageSize else {
            throw CapabilityError.invalidParams("a box needs the imageSize it was drawn on", field: "target")
        }
        guard let last = lock.withLock({ lastLook }) else {
            throw CapabilityError(.conflict, reason: "no_look", "There is no picture to point at; the owner has to press Let Psyche look")
        }
        let drawn = CGSize(width: isz.width, height: isz.height)
        guard PointsBoxMapping.sameShape(drawn, last.imageSize) else {
            throw CapabilityError.invalidParams("the box was drawn on a different picture than the last look", field: "target")
        }
        // The picture is only good while the window sits where it was.
        guard let now = await currentWindowFrame(), PointsGeometry.sameWindow(now, last.window) else {
            throw CapabilityError(.conflict, reason: "window_moved", "The window moved since the picture; the owner has to ask again")
        }
        let displays = await MainActor.run { PointsScreens.displays().map(\.frame) }
        guard let rect = PointsBoxMapping.screenRect(
            box: CGRect(x: r.x, y: r.y, width: r.width, height: r.height), imageSize: drawn, window: last.window, displays: displays)
        else {
            throw CapabilityError.invalidParams("the box is not on the window", field: "target")
        }
        let sensitive = PointsBoxMapping.touchesAny(rect, in: last.masks)
        let info = PointsTargetInfo(
            fieldId: "box", label: "", role: .text, sensitive: sensitive, frame: rect, nextIds: [], nextFrames: [], windowFrame: last.window)
        lock.withLock { shownTarget = nil }
        var step = Self.step(p, info: info)
        // Backstop: a value shaped like a secret is dropped even when the box touches no mask.
        if let v = step.value, sensitive || PointsValueRules.classify(v) != nil { step.value = nil }
        overlay.show(step)
        return true
    }

    /// Waits for the thread to finish (tests, clean shutdown).
    func waitUntilExited(timeout: TimeInterval) -> Bool { exited.wait(timeout: .now() + timeout) == .success }

    private func perform(on run: CFRunLoop, _ block: @escaping @Sendable () -> Void) {
        CFRunLoopPerformBlock(run, CFRunLoopMode.commonModes.rawValue, block)
        CFRunLoopWakeUp(run)
    }

    private func perform(_ block: @escaping @Sendable () -> Void) {
        guard let run = lock.withLock({ loop }) else { return }
        perform(on: run, block)
    }

    /// The fields the overlay watches: their frames are re-read after a scroll or a move.
    func setWatched(_ ids: [String]) {
        lock.withLock { watching = !ids.isEmpty }
        perform { [self] in engine.setWatched(ids) }
    }

    // MARK: Install and teardown (on the observer thread)

    private func install(_ run: CFRunLoop) -> Bool {
        var made: AXObserver?
        guard AXObserverCreate(pid, { _, element, notification, refcon in
            guard let refcon else { return }
            Unmanaged<PointsSessionController>.fromOpaque(refcon).takeUnretainedValue().notified(element, notification as String)
        }, &made) == .success, let obs = made else { return false }
        observer = obs
        let ref = Unmanaged.passUnretained(self).toOpaque()
        for n in Self.appNotifications { AXObserverAddNotification(obs, source.appElement, n as CFString, ref) }
        for n in Self.windowNotifications { AXObserverAddNotification(obs, source.window, n as CFString, ref) }
        registerWebArea()
        if let f = source.focusedElement()?.element { watchField(f) }
        CFRunLoopAddSource(run, AXObserverGetRunLoopSource(obs), .commonModes)
        // One-shot timer, parked in the far future until the engine has a deadline.
        let tm = CFRunLoopTimerCreateWithHandler(nil, Date.distantFuture.timeIntervalSinceReferenceDate, 0, 0, 0) { [weak self] _ in
            self?.timerFired()
        }
        timer = tm
        CFRunLoopAddTimer(run, tm, .commonModes)
        let pid = self.pid
        let center = NSWorkspace.shared.notificationCenter
        terminationObserver = center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: nil) { [weak self] note in
            guard (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier == pid else { return }
            guard let s = self else { return }
            s.perform { s.deliver(.appTerminated) }
        }
        return true
    }

    private func teardown(_ run: CFRunLoop) {
        if let obs = observer {
            for n in Self.appNotifications { AXObserverRemoveNotification(obs, source.appElement, n as CFString) }
            for n in Self.windowNotifications { AXObserverRemoveNotification(obs, source.window, n as CFString) }
            if let w = webArea { for n in Self.webAreaNotifications { AXObserverRemoveNotification(obs, w, n as CFString) } }
            if let f = watchedField { for n in Self.focusedNotifications { AXObserverRemoveNotification(obs, f, n as CFString) } }
            CFRunLoopRemoveSource(run, AXObserverGetRunLoopSource(obs), .commonModes)
        }
        if let tm = timer {
            CFRunLoopTimerInvalidate(tm)
            CFRunLoopRemoveTimer(run, tm, .commonModes)
        }
        if let o = terminationObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        observer = nil
        timer = nil
        watchedField = nil
        webArea = nil
    }

    // MARK: Notifications (on the observer thread)

    private func notified(_ element: AXUIElement, _ notification: String) {
        guard stillTheSameApp() else { return }
        switch notification {
        case kAXFocusedUIElementChangedNotification:
            let focused = source.focusedElement()
            if let f = focused?.element { watchField(f) } else { unwatchField() }
            deliver(.focusChanged(focused))
        case kAXValueChangedNotification:
            let key = AXKey(element: element)
            if let id = engine.fieldId(for: key), id == lock.withLock({ shownTarget }) { overlay.typing() }
            deliver(.valueChanged(key))
        case "AXLoadComplete", kAXTitleChangedNotification, kAXLayoutChangedNotification: deliver(.layoutChanged)
        case kAXUIElementDestroyedNotification:
            if CFEqual(element, source.window) { deliver(.windowDestroyed) } else { deliver(.destroyed(AXKey(element: element))) }
        case kAXMovedNotification, kAXResizedNotification: deliver(.geometryChanged)
        case kAXWindowMiniaturizedNotification: deliver(.windowMiniaturized(true))
        case kAXWindowDeminiaturizedNotification: deliver(.windowMiniaturized(false))
        case kAXApplicationActivatedNotification: deliver(.appActive(true))
        case kAXApplicationDeactivatedNotification: deliver(.appActive(false))
        case kAXApplicationHiddenNotification: deliver(.appHidden(true))
        case kAXApplicationShownNotification: deliver(.appHidden(false))
        default: break
        }
    }

    private func deliver(_ n: PointsNotification<AXKey>) {
        engine.notify(n, at: Self.now())
        afterWork()
    }

    private func timerFired() { afterWork() }

    /// Runs what is due, refreshes the web-area watch after a page change and re-arms the timer.
    private func afterWork() {
        let before = engine.currentFieldCount
        engine.tick(at: Self.now())
        if engine.currentFieldCount != before { registerWebArea() }
        guard let tm = timer else { return }
        if let d = engine.nextDeadline {
            let delta = max(0, d - Self.now())
            CFRunLoopTimerSetNextFireDate(tm, CFAbsoluteTimeGetCurrent() + delta)
        } else {
            CFRunLoopTimerSetNextFireDate(tm, Date.distantFuture.timeIntervalSinceReferenceDate)
        }
        if engine.ended { CFRunLoopStop(CFRunLoopGetCurrent()) }
    }

    /// The value and destroy watch moves with focus: one field at a time (as in teach).
    private func watchField(_ f: AXUIElement) {
        guard let obs = observer else { return }
        if let old = watchedField, CFEqual(old, f) { return }
        unwatchField()
        let ref = Unmanaged.passUnretained(self).toOpaque()
        for n in Self.focusedNotifications { AXObserverAddNotification(obs, f, n as CFString, ref) }
        watchedField = f
    }

    private func unwatchField() {
        guard let obs = observer, let old = watchedField else { return }
        for n in Self.focusedNotifications { AXObserverRemoveNotification(obs, old, n as CFString) }
        watchedField = nil
    }

    /// `AXLoadComplete` and layout changes come from the web area, which a navigation can replace.
    private func registerWebArea() {
        guard let obs = observer else { return }
        let found = findWebArea(source.window, depth: 0, budget: 400)
        if let w = webArea, let found, CFEqual(w, found) { return }
        let ref = Unmanaged.passUnretained(self).toOpaque()
        if let w = webArea { for n in Self.webAreaNotifications { AXObserverRemoveNotification(obs, w, n as CFString) } }
        webArea = found
        if let found { for n in Self.webAreaNotifications { AXObserverAddNotification(obs, found, n as CFString, ref) } }
    }

    private func findWebArea(_ e: AXUIElement, depth: Int, budget: Int) -> AXUIElement? {
        var left = budget
        func go(_ e: AXUIElement, _ depth: Int) -> AXUIElement? {
            if left <= 0 || depth > 8 { return nil }
            left -= 1
            if AX.string(AX.attr(e, "AXRole")) == "AXWebArea" { return e }
            for c in AX.elements(AX.attr(e, "AXChildren")) { if let w = go(c, depth + 1) { return w } }
            return nil
        }
        return go(e, depth)
    }

    /// The pid still names the app the session started with: same bundle id and launch date (a
    /// reused pid differs) and the same code-signing Team ID (re-read at most once a second).
    private func stillTheSameApp() -> Bool {
        let t = Self.now()
        if t - lastIdentityCheck < 1, lastIdentityCheck != 0 { return true }
        lastIdentityCheck = t
        guard let running = NSRunningApplication(processIdentifier: pid), running.launchDate == launchDate,
              running.bundleIdentifier?.lowercased() == bundleId.lowercased(), codeSigningTeamID(pid: pid) == teamId
        else {
            engine.end(.appChanged)
            afterWork()
            return false
        }
        return true
    }

    // MARK: Scroll (listen only)

    /// There is no AX notification for scrolling in web areas. A global monitor sees the wheel
    /// events of every app (listen only, no Input Monitoring needed) and wakes the observer thread
    /// at most 30 times a second, and only while the overlay watches a field.
    private func installScrollMonitor() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let alreadyStopped = lock.withLock { stopped }
            if alreadyStopped { return }
            scrollMonitor = NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { [weak self] _ in self?.scrolled() }
        }
    }

    private func removeScrollMonitor() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let m = scrollMonitor else { return }
            NSEvent.removeMonitor(m)
            scrollMonitor = nil
        }
    }

    private func scrolled() {
        let t = Self.now()
        let go: Bool = lock.withLock {
            guard watching, t - lastScroll >= PointsCoalescer.minFramesGap else { return false }
            lastScroll = t
            return true
        }
        if go { perform { [self] in deliver(.geometryChanged) } }
    }
}

/// Resumes a continuation once, from whichever of two paths gets there first.
final class ResumeOnce<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<T, Never>?

    init(_ cont: CheckedContinuation<T, Never>) { self.cont = cont }

    func resume(_ value: T) {
        let c = lock.withLock { () -> CheckedContinuation<T, Never>? in
            let c = cont
            cont = nil
            return c
        }
        c?.resume(returning: value)
    }
}

/// A set-once flag readable from another thread.
final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.withLock { value = true } }
    /// Sets the flag; true if this call was the one that set it.
    func clear() { lock.withLock { value = false } }
    func testAndSet() -> Bool { lock.withLock { let was = value; value = true; return !was } }
    var isSet: Bool { lock.withLock { value } }
}

/// Code-signing Team ID of a running process (nil when unsigned or unreadable).
func codeSigningTeamID(pid: pid_t) -> String? {
    var code: SecCode?
    let attrs = [kSecGuestAttributePid: pid] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess, let code else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let dict = info as? [String: Any]
    else { return nil }
    return dict[kSecCodeInfoTeamIdentifier as String] as? String
}
