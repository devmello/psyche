import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import PsycheHelperCore

/// A thread that runs a run loop for a source's observer and tap. `start` returns once `install`
/// has run on the new thread. Nothing here takes a lock the caller holds, so a caller holding its
/// own state lock around `start` cannot deadlock against the thread (it did once: the thread
/// needed the caller's lock before it could signal readiness).
///
/// The thread runs its loop in short slices and checks a stop flag between them, so a `stop()`
/// that arrives before the loop is running is not lost. A `start` that times out marks the thread
/// cancelled: it installs nothing if it has not yet, and tears down what it did install.
final class RunLoopThread: @unchecked Sendable {
    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var loop: CFRunLoop?
        var stop = false
        var cancelled = false
    }
    private let name: String
    private let state = State()
    private let exited = DispatchSemaphore(value: 0)

    init(name: String) { self.name = name }

    /// Runs `install(loop)` on the new thread; `teardown(loop)` runs on that thread when it ends.
    /// False if it did not come up in `timeout` (the thread then ends by itself).
    func start(
        timeout: TimeInterval = 5, install: @escaping @Sendable (CFRunLoop) -> Void, teardown: (@Sendable (CFRunLoop) -> Void)? = nil
    ) -> Bool {
        let ready = DispatchSemaphore(value: 0)
        let state = self.state
        let exited = self.exited
        let t = Thread {
            let loop = CFRunLoopGetCurrent()!
            // Cancelled before it began: install nothing.
            if state.lock.withLock({ state.cancelled }) {
                exited.signal()
                return
            }
            state.lock.withLock { state.loop = loop }
            install(loop)
            ready.signal()
            while !state.lock.withLock({ state.stop || state.cancelled }) {
                if CFRunLoopRunInMode(.defaultMode, 0.25, false) == .finished { Thread.sleep(forTimeInterval: 0.05) }
            }
            teardown?(loop)
            exited.signal()
        }
        t.name = name
        t.qualityOfService = .userInitiated
        t.start()
        guard ready.wait(timeout: .now() + timeout) == .success else {
            state.lock.withLock { state.cancelled = true }
            return false
        }
        return true
    }

    /// Ends the thread; safe to call twice, from any thread, and before the loop is running.
    func stop() {
        let loop: CFRunLoop? = state.lock.withLock {
            state.stop = true
            return state.loop
        }
        if let loop { CFRunLoopStop(loop) }
    }

    /// True once the thread's body has finished (for tests and for a clean shutdown).
    func waitUntilExited(timeout: TimeInterval) -> Bool {
        if exited.wait(timeout: .now() + timeout) == .success {
            exited.signal()  // stays signalled for a second caller
            return true
        }
        return false
    }
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

/// The live source for "Record in an app": an `AXObserver` on one process for focus, menu-item and
/// deactivation notifications, a value-changed watch on the focused field only, and a listen-only
/// mouse tap for that process alone (`tapCreateForPid`; AX has no notification for a press). It
/// reads an element's role, titles, identifier and neighbouring labels, never a field's contents
/// unless `AppTeachPolicy` cleared the field. No screenshots are taken.
///
/// The recording is bound to the process id, its launch date and its code-signing Team ID at
/// start, and every event re-checks that the pid still names the same app (a Team ID check at
/// most once a second). An audit token would be tighter, but `AXUIElement` does not give one.
///
/// Not exercised by the unit tests (it needs Accessibility and a real app); the decisions it feeds
/// are, with recorded events (`AppTeachTests`), and its thread is (`RunLoopThreadTests`).
final class LiveAppTeachSource: AppTeachSource, @unchecked Sendable {
    private static let notifications = [kAXFocusedUIElementChangedNotification, kAXMenuItemSelectedNotification, kAXApplicationDeactivatedNotification]

    private let queue = DispatchQueue(label: "com.psyche.helper.teach-app")
    private let lock = NSLock()
    private var bundleId = ""
    private var pid: pid_t = 0
    private var teamId: String?
    private var launchDate: Date?
    private var lastTeamCheck = Date.distantPast
    private var observer: AXObserver?
    private var appElement: AXUIElement?
    private var valueWatched: AXUIElement?
    private var loopThread: RunLoopThread?
    private var tap: CFMachPort?
    private var tapRef: UnsafeMutableRawPointer?
    private var onEvent: (@Sendable (AppTeachEvent, Date) -> Void)?
    private var onEnd: (@Sendable () -> Void)?
    private var termination: NSObjectProtocol?
    private var menuCandidate: AppTeachElement?
    /// Set by `stop()` under the lock. A `start` still in flight sees it at the end and tears down.
    private var stopRequested = false

    func start(
        bundleId: String, bind: @escaping @Sendable (Int32) -> Void, onEvent: @escaping @Sendable (AppTeachEvent, Date) -> Void,
        onEnd: @escaping @Sendable () -> Void
    ) -> Bool {
        guard AXIsProcessTrusted(),
              let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier?.lowercased() == bundleId.lowercased() })
        else { return false }
        // Quick state check only; nothing below waits on another thread while holding the lock.
        let fresh = lock.withLock { () -> Bool in
            guard observer == nil, loopThread == nil else { return false }
            stopRequested = false
            self.bundleId = bundleId
            self.onEvent = onEvent
            self.onEnd = onEnd
            return true
        }
        guard fresh else { return false }
        let pid = app.processIdentifier
        self.pid = pid
        teamId = codeSigningTeamID(pid: pid)
        launchDate = app.launchDate
        lastTeamCheck = Date()
        bind(pid)
        let appEl = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appEl, 0.5)

        var made: AXObserver?
        guard AXObserverCreate(pid, { _, element, notification, refcon in
            guard let refcon else { return }
            Unmanaged<LiveAppTeachSource>.fromOpaque(refcon).takeUnretainedValue().notified(element, notification as String)
        }, &made) == .success, let obs = made else { reset(); return false }
        let ref = Unmanaged.passRetained(self).toOpaque()
        // Focus, menu and deactivation notifications only. A value watch is added on the focused field alone.
        for n in Self.notifications { AXObserverAddNotification(obs, appEl, n as CFString, ref) }

        // The tap sees this process's events and nothing else; without it there is no recording.
        let types: [CGEventType] = [.leftMouseDown, .leftMouseUp]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        guard let port = CGEvent.tapCreateForPid(
            pid: pid, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                if let refcon { Unmanaged<LiveAppTeachSource>.fromOpaque(refcon).takeUnretainedValue().mouse(type, event) }
                return Unmanaged.passUnretained(event)
            }, userInfo: ref
        ) else {
            for n in Self.notifications { AXObserverRemoveNotification(obs, appEl, n as CFString) }
            Unmanaged<LiveAppTeachSource>.fromOpaque(ref).release()
            reset()
            return false
        }

        final class Sources: @unchecked Sendable {
            var tap: CFRunLoopSource?
        }
        let sources = Sources()
        let thread = RunLoopThread(name: "com.psyche.helper.teach-app-ax")
        let obsBox = UncheckedSendable(obs)
        let portBox = UncheckedSendable(port)
        // Neither closure takes a lock of ours.
        let up = thread.start(install: { loop in
            CFRunLoopAddSource(loop, AXObserverGetRunLoopSource(obsBox.value), .commonModes)
            if let src = CFMachPortCreateRunLoopSource(nil, portBox.value, 0) {
                sources.tap = src
                CFRunLoopAddSource(loop, src, .commonModes)
                CGEvent.tapEnable(tap: portBox.value, enable: true)
            }
        }, teardown: { loop in
            CFRunLoopRemoveSource(loop, AXObserverGetRunLoopSource(obsBox.value), .commonModes)
            if let src = sources.tap { CFRunLoopRemoveSource(loop, src, .commonModes) }
        })
        guard up else {
            // The thread did not come up: take the notifications and the tap back off as well.
            for n in Self.notifications { AXObserverRemoveNotification(obs, appEl, n as CFString) }
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
            Unmanaged<LiveAppTeachSource>.fromOpaque(ref).release()
            reset()
            return false
        }
        lock.withLock {
            observer = obs
            appElement = appEl
            tap = port
            tapRef = ref
            loopThread = thread
        }
        termination = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: nil) { [pid] note in
            if (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier == pid { onEnd() }
        }
        // A Stop or Cancel that came in while this was starting: undo all of it.
        if lock.withLock({ stopRequested }) {
            stop()
            return false
        }
        // Where the owner already is: the focused field becomes the first typing target.
        queue.async { [weak self] in self?.focusChanged(nil) }
        return true
    }

    private func reset() {
        lock.withLock {
            onEvent = nil
            onEnd = nil
        }
    }

    func stop() {
        lock.lock()
        stopRequested = true
        let obs = observer, appEl = appElement, watched = valueWatched, port = tap, thread = loopThread, ref = tapRef, term = termination
        observer = nil
        appElement = nil
        valueWatched = nil
        tap = nil
        loopThread = nil
        tapRef = nil
        termination = nil
        onEvent = nil
        onEnd = nil
        menuCandidate = nil
        lock.unlock()
        if let term { NSWorkspace.shared.notificationCenter.removeObserver(term) }
        if let port {
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
        }
        if let obs {
            if let appEl { for n in Self.notifications { AXObserverRemoveNotification(obs, appEl, n as CFString) } }
            if let watched { AXObserverRemoveNotification(obs, watched, kAXValueChangedNotification as CFString) }
        }
        thread?.stop()
        if let ref {
            // Queued callbacks may still hold the pointer; release after them.
            let box = UncheckedSendable(ref)
            queue.async { Unmanaged<LiveAppTeachSource>.fromOpaque(box.value).release() }
        }
    }

    // MARK: Notifications

    private func notified(_ element: AXUIElement, _ notification: String) {
        let box = UncheckedSendable(element)
        queue.async { [self] in
            guard stillTheSameApp() else { return }
            let el = box.value
            switch notification {
            case kAXFocusedUIElementChangedNotification: focusChanged(el)
            case kAXApplicationDeactivatedNotification: clearFocus()
            case kAXValueChangedNotification: valueChanged(el)
            default: break  // a menu item being highlighted is not a choice; the click is
            }
        }
    }

    private func emit(_ event: AppTeachEvent) {
        let handler = lock.withLock { onEvent }
        handler?(event, Date())
    }

    /// The pid still names the app the recording started with: same bundle id and launch date
    /// (a reused pid differs), and the same code-signing Team ID (re-read at most once a second).
    /// Runs on every event.
    private func stillTheSameApp() -> Bool {
        var same = false
        if let running = NSRunningApplication(processIdentifier: pid), running.launchDate == launchDate,
           running.bundleIdentifier?.lowercased() == bundleId.lowercased()
        {
            same = true
            if Date().timeIntervalSince(lastTeamCheck) > 1 {
                lastTeamCheck = Date()
                same = codeSigningTeamID(pid: pid) == teamId
            }
        }
        if !same {
            let end = lock.withLock { onEnd }
            end?()
        }
        return same
    }

    /// Drops the value watch on the previous field, always: a focus change ends it.
    private func dropValueWatch() {
        guard let obs = lock.withLock({ observer }) else { return }
        let previous = lock.withLock { () -> AXUIElement? in
            let p = valueWatched
            valueWatched = nil
            return p
        }
        if let previous { AXObserverRemoveNotification(obs, previous, kAXValueChangedNotification as CFString) }
    }

    private func clearFocus() {
        dropValueWatch()
        emit(.focusCleared)
    }

    private func focusChanged(_ given: AXUIElement?) {
        guard let obs = lock.withLock({ observer }) else { return }
        dropValueWatch()
        let el: AXUIElement? = given.flatMap(Self.focused(in:)) ?? lock.withLock({ appElement }).flatMap { Self.focused(in: $0) }
        // Focus went somewhere we do not describe (another process, an XPC view service, a
        // cross-process sheet): tell the mapper, so nothing typed there is attributed to the last field.
        guard let el, let info = Self.element(el, pid: pid, bundleId: bundleId) else {
            emit(.focusCleared)
            return
        }
        lock.withLock { valueWatched = el }
        if let ref = lock.withLock({ tapRef }) { AXObserverAddNotification(obs, el, kAXValueChangedNotification as CFString, ref) }
        // What the field already holds is not what the owner types: read it once, only if it is not secret.
        var initial: String?
        if !AppTeachPolicy.isSecret(info), AXKeyRead.isTextRole(info.role) {
            initial = AX.string(AX.attr(el, kAXValueAttribute)).map { String($0.prefix(2000)) }
        }
        emit(.focus(info, initial: initial))
    }

    private func valueChanged(_ el: AXUIElement) {
        // Only the focused field's value counts.
        guard let watched = lock.withLock({ valueWatched }), CFEqual(watched, el) else { return }
        guard var info = Self.element(el, pid: pid, bundleId: bundleId) else { return }
        info.secureInput = info.secureInput || IsSecureEventInputEnabled()
        // The field's contents are read only when its role, labels and the input state say it is
        // not a secret field. The mapper checks again.
        var value: String?
        if !AppTeachPolicy.isSecret(info), AXKeyRead.isTextRole(info.role) {
            value = AX.string(AX.attr(el, kAXValueAttribute)).map { String($0.prefix(2000)) }
        }
        emit(.valueChanged(info, value: value))
    }

    // MARK: Mouse

    private func mouse(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let port = lock.withLock({ tap }) { CGEvent.tapEnable(tap: port, enable: true) }
            return
        }
        guard event.getIntegerValueField(.eventSourceUserData) != Input.marker else { return }
        // Belt and braces: the tap is already per process.
        guard pid_t(event.getIntegerValueField(.eventTargetUnixProcessID)) == pid else { return }
        let point = event.location
        let down = type == .leftMouseDown
        queue.async { [self] in
            guard stillTheSameApp() else { return }
            if down {
                guard var info = Self.element(at: point, pid: pid, bundleId: bundleId) else { return }
                info.secureInput = info.secureInput || IsSecureEventInputEnabled()
                if AppTeachRoles.menuItems.contains(info.role) {
                    lock.withLock { menuCandidate = info }
                } else {
                    emit(.press(info))
                }
            } else if let item = lock.withLock({ () -> AppTeachElement? in
                let c = menuCandidate
                menuCandidate = nil
                return c
            }) {
                emit(.menuChosen(item))
            }
        }
    }

    // MARK: Reading elements

    static func focused(in el: AXUIElement) -> AXUIElement? {
        AX.element(AX.attr(el, kAXFocusedUIElementAttribute))
    }

    static func element(at point: CGPoint, pid: pid_t, bundleId: String) -> AppTeachElement? {
        var el: AXUIElement?
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.5)
        guard AXUIElementCopyElementAtPosition(sys, Float(point.x), Float(point.y), &el) == .success, let el else { return nil }
        return element(el, pid: pid, bundleId: bundleId)
    }

    /// Role, titles, identifier, the titles of its ancestors and, for a menu item, the menu path.
    /// The element's process is checked **before any attribute is read**; anything outside the
    /// recorded process yields nothing. Never `AXValue`. The path leaves out window titles (a
    /// document's name), and the titles of rows, cells, web areas and tab groups (the user's data;
    /// `AppTeachRoles.pathTitle`). A window's title and the labels just before a field are kept in
    /// `context` for the secret-word check only.
    static func element(_ el: AXUIElement, pid expected: pid_t, bundleId: String) -> AppTeachElement? {
        guard AX.pid(el) == expected else { return nil }
        AXUIElementSetMessagingTimeout(el, 0.5)
        let role = AX.string(AX.attr(el, kAXRoleAttribute)) ?? "AXUnknown"
        var out = AppTeachElement(
            bundleId: bundleId, appName: NSRunningApplication(processIdentifier: expected)?.localizedName ?? "App", role: role,
            subrole: AX.string(AX.attr(el, kAXSubroleAttribute)),
            title: AX.string(AX.attr(el, kAXTitleAttribute)), description: AX.string(AX.attr(el, kAXDescriptionAttribute)),
            identifier: AX.string(AX.attr(el, kAXIdentifierAttribute)), placeholder: AX.string(AX.attr(el, kAXPlaceholderValueAttribute)),
            secureInput: IsSecureEventInputEnabled(), pid: expected
        )
        // A row, cell or pop-up button is the user's data: nothing but its role is kept (the mapper drops the rest).
        if AppTeachRoles.dataRoles.contains(role) { return out }
        if let labelEl = AX.element(AX.attr(el, kAXTitleUIElementAttribute)) {
            out.labelText = AX.string(AX.attr(labelEl, kAXValueAttribute)) ?? AX.string(AX.attr(labelEl, kAXTitleAttribute))
        }
        // Linked labels ("Verification code" drawn beside a box) count for the secret-word check.
        for linked in AX.elements(AX.attr(el, "AXLinkedUIElements")).prefix(3) {
            if let t = AX.string(AX.attr(linked, kAXTitleAttribute)) ?? AX.string(AX.attr(linked, kAXValueAttribute)), !t.isEmpty {
                out.nearby.append(String(t.prefix(120)))
            }
        }
        // Context for the word check, never kept: the window's title, and the static texts just before a text field.
        if AppTeachRoles.textInputs.contains(role) {
            if let w = AX.element(AX.attr(el, kAXWindowAttribute)), let t = AX.string(AX.attr(w, kAXTitleAttribute)), !t.isEmpty {
                out.context.append(String(t.prefix(120)))
            }
            if let parent = AX.element(AX.attr(el, kAXParentAttribute)) {
                let siblings = AX.elements(AX.attr(parent, kAXChildrenAttribute))
                if let i = siblings.firstIndex(where: { CFEqual($0, el) }) {
                    for sib in siblings[max(0, i - 3)..<i] where AX.string(AX.attr(sib, kAXRoleAttribute)) == "AXStaticText" {
                        if let t = AX.string(AX.attr(sib, kAXValueAttribute)) ?? AX.string(AX.attr(sib, kAXTitleAttribute)), !t.isEmpty {
                            out.context.append(String(t.prefix(120)))
                        }
                    }
                }
            }
        }
        var path: [String] = []
        var menu: [String] = []
        var cursor = AX.element(AX.attr(el, kAXParentAttribute))
        var depth = 0
        while let c = cursor, depth < 12 {
            let r = AX.string(AX.attr(c, kAXRoleAttribute)) ?? ""
            let t = AX.string(AX.attr(c, kAXTitleAttribute)) ?? ""
            if r == "AXMenuItem" || r == "AXMenuBarItem" || r == "AXMenuButton" {
                if !t.isEmpty { menu.insert(t, at: 0) }
            } else if r != "AXMenu", r != "AXMenuBar", let title = AppTeachRoles.pathTitle(role: r, title: t) {
                path.insert(title, at: 0)
            }
            cursor = AX.element(AX.attr(c, kAXParentAttribute))
            depth += 1
        }
        out.path = path
        if AppTeachRoles.menuItems.contains(role) { out.menuPath = menu + [out.title ?? ""].filter { !$0.isEmpty } }
        return out
    }
}

enum AXKeyRead {
    /// Only text-like roles have a string value worth keeping.
    static func isTextRole(_ role: String) -> Bool { ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) }
}

/// A menu-bar item with a Stop. The owner can end the recording from it whether or not the
/// Psyche app is in front or even running.
final class LiveAppTeachIndicator: AppTeachIndicator, @unchecked Sendable {
    private let lock = NSLock()
    private var item: NSStatusItem?
    private var target: StopTarget?

    private final class StopTarget: NSObject, @unchecked Sendable {
        let onStop: @Sendable () -> Void
        init(_ onStop: @escaping @Sendable () -> Void) { self.onStop = onStop }
        @objc func stop() { onStop() }
    }

    func show(appName: String, onStop: @escaping @Sendable () -> Void) {
        DispatchQueue.main.async { [self] in
            hideOnMain()
            let stopTarget = StopTarget(onStop)
            let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            status.button?.title = "● Recording \(appName)"
            status.button?.setAccessibilityLabel("Psyche is recording what you do in \(appName)")
            let menu = NSMenu()
            let header = NSMenuItem(title: "Psyche is recording in \(appName)", action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            let stop = NSMenuItem(title: "Stop recording", action: #selector(StopTarget.stop), keyEquivalent: "")
            stop.target = stopTarget
            menu.addItem(stop)
            status.menu = menu
            lock.withLock {
                item = status
                target = stopTarget
            }
        }
    }

    func hide() { DispatchQueue.main.async { [self] in hideOnMain() } }

    private func hideOnMain() {
        let old = lock.withLock { () -> NSStatusItem? in
            let i = item
            item = nil
            target = nil
            return i
        }
        if let old { NSStatusBar.system.removeStatusItem(old) }
    }
}

extension AppTeachCapabilities {
    /// The live controller: AXObserver source, menu-bar indicator, the owner's tiers re-read at each start.
    static func live(computer: ComputerUse, environment: [String: String], log: HelperLog) -> AppTeachController {
        let path = TierSettings.path(environment: environment)
        return AppTeachController(
            makeSource: { LiveAppTeachSource() }, indicator: LiveAppTeachIndicator(),
            settings: { TierSettings.load(path: path) },
            appName: { id in NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier?.lowercased() == id.lowercased() }?.localizedName },
            log: log
        )
    }
}
