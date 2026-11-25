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

    init(sessionId: String, app: NSRunningApplication, window: AXUIElement, target: PointsTarget, teamId: String?) {
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
        engine = PointsEngine(source: source, target: target) { if !closed.isSet { c.yield($0) } }
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
        return true
    }

    private func finish() {
        removeScrollMonitor()
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
        case kAXValueChangedNotification: deliver(.valueChanged(AXKey(element: element)))
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

/// A set-once flag readable from another thread.
final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.withLock { value = true } }
    /// Sets the flag; true if this call was the one that set it.
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
