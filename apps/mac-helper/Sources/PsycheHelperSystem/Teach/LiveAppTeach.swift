import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import PsycheHelperCore

/// The live source for "Record in an app": an `AXObserver` on one app for focus, value and
/// menu-item notifications, plus a listen-only mouse tap for presses and menu choices (AX has no
/// notification for a button press). Nothing here decides what is kept: it reads an element's
/// role, titles and identifier, never a field's contents unless `AppTeachPolicy` already cleared
/// the field, and hands `AppTeachEvent`s to the mapper. No screenshots are taken.
///
/// Not exercised by the unit tests (it needs Accessibility and a real app); the decisions it
/// feeds are, with recorded event fixtures (`AppTeachTests`).
final class LiveAppTeachSource: AppTeachSource, @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.psyche.helper.teach-app")
    private let lock = NSLock()
    private var bundleId = ""
    private var pid: pid_t = 0
    private var observer: AXObserver?
    private var appElement: AXUIElement?
    private var valueWatched: AXUIElement?
    private var runLoop: CFRunLoop?
    private var tap: CFMachPort?
    private var tapRef: UnsafeMutableRawPointer?
    private var onEvent: (@Sendable (AppTeachEvent, Date) -> Void)?
    private var termination: NSObjectProtocol?
    private var menuCandidate: AppTeachElement?

    func start(bundleId: String, onEvent: @escaping @Sendable (AppTeachEvent, Date) -> Void, onEnd: @escaping @Sendable () -> Void) -> Bool {
        guard AXIsProcessTrusted(),
              let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier?.lowercased() == bundleId.lowercased() })
        else { return false }
        lock.lock()
        defer { lock.unlock() }
        guard observer == nil else { return false }
        self.bundleId = bundleId
        self.onEvent = onEvent
        pid = app.processIdentifier
        let appEl = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appEl, 0.5)
        appElement = appEl

        var obs: AXObserver?
        guard AXObserverCreate(pid, { _, element, notification, refcon in
            guard let refcon else { return }
            Unmanaged<LiveAppTeachSource>.fromOpaque(refcon).takeUnretainedValue().notified(element, notification as String)
        }, &obs) == .success, let obs else { return false }
        observer = obs
        let ref = Unmanaged.passRetained(self).toOpaque()
        tapRef = ref
        for n in [kAXFocusedUIElementChangedNotification, kAXMenuItemSelectedNotification, kAXValueChangedNotification] {
            AXObserverAddNotification(obs, appEl, n as CFString, ref)
        }

        let types: [CGEventType] = [.leftMouseDown, .leftMouseUp]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                if let refcon { Unmanaged<LiveAppTeachSource>.fromOpaque(refcon).takeUnretainedValue().mouse(type, event) }
                return Unmanaged.passUnretained(event)
            }, userInfo: ref
        )

        let ready = DispatchSemaphore(value: 0)
        let obsBox = UncheckedSendable(obs)
        let tapBox = UncheckedSendable(tap)
        let t = Thread { [weak self, obsBox, tapBox] in
            CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obsBox.value), .commonModes)
            if let port = tapBox.value, let src = CFMachPortCreateRunLoopSource(nil, port, 0) {
                CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
                CGEvent.tapEnable(tap: port, enable: true)
            }
            self?.lock.withLock { self?.runLoop = CFRunLoopGetCurrent() }
            ready.signal()
            CFRunLoopRun()
        }
        t.name = "com.psyche.helper.teach-app-ax"
        t.qualityOfService = .userInitiated
        t.start()
        ready.wait()

        termination = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: nil) { [pid] note in
            if (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier == pid { onEnd() }
        }
        // Where the owner already is: the focused field becomes the first typing target.
        queue.async { [weak self] in self?.focusChanged(nil) }
        return true
    }

    func stop() {
        lock.lock()
        let obs = observer, appEl = appElement, watched = valueWatched, port = tap, loop = runLoop, ref = tapRef, term = termination
        observer = nil
        appElement = nil
        valueWatched = nil
        tap = nil
        runLoop = nil
        tapRef = nil
        termination = nil
        onEvent = nil
        menuCandidate = nil
        lock.unlock()
        if let term { NSWorkspace.shared.notificationCenter.removeObserver(term) }
        if let obs {
            if let appEl {
                for n in [kAXFocusedUIElementChangedNotification, kAXMenuItemSelectedNotification, kAXValueChangedNotification] {
                    AXObserverRemoveNotification(obs, appEl, n as CFString)
                }
            }
            if let watched { AXObserverRemoveNotification(obs, watched, kAXValueChangedNotification as CFString) }
            CFRunLoopRemoveSource(loop ?? CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .commonModes)
        }
        if let port {
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
        }
        if let loop { CFRunLoopStop(loop) }
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
            let el = box.value
            switch notification {
            case kAXFocusedUIElementChangedNotification: focusChanged(el)
            case kAXValueChangedNotification: valueChanged(el)
            default: break  // a menu item being highlighted is not a choice; the click is
            }
        }
    }

    private func emit(_ event: AppTeachEvent) {
        let handler = lock.withLock { onEvent }
        handler?(event, Date())
    }

    private func focusChanged(_ given: AXUIElement?) {
        guard let obs = lock.withLock({ observer }) else { return }
        let el: AXUIElement? = given.flatMap(Self.focused(in:)) ?? lock.withLock({ appElement }).flatMap { Self.focused(in: $0) }
        guard let el, let info = Self.element(el, bundleId: bundleId) else { return }
        // Watch value changes on this field only; the previous field stops being watched.
        let previous = lock.withLock { () -> AXUIElement? in
            let p = valueWatched
            valueWatched = el
            return p
        }
        if let previous { AXObserverRemoveNotification(obs, previous, kAXValueChangedNotification as CFString) }
        if let ref = lock.withLock({ tapRef }) { AXObserverAddNotification(obs, el, kAXValueChangedNotification as CFString, ref) }
        emit(.focus(info))
    }

    private func valueChanged(_ el: AXUIElement) {
        guard var info = Self.element(el, bundleId: bundleId) else { return }
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
        let point = event.location
        let down = type == .leftMouseDown
        queue.async { [self] in
            if down {
                guard var info = Self.element(at: point, bundleId: bundleId) else { return }
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
        return AX.element(AX.attr(el, kAXFocusedUIElementAttribute))
    }

    static func element(at point: CGPoint, bundleId: String) -> AppTeachElement? {
        var el: AXUIElement?
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.5)
        guard AXUIElementCopyElementAtPosition(sys, Float(point.x), Float(point.y), &el) == .success, let el else { return nil }
        return element(el, bundleId: bundleId)
    }

    /// Role, titles, identifier, the titles of its ancestors and, for a menu item, the menu path.
    /// Never `AXValue`.
    static func element(_ el: AXUIElement, bundleId expected: String) -> AppTeachElement? {
        guard let pid = AX.pid(el), let app = NSRunningApplication(processIdentifier: pid) else { return nil }
        AXUIElementSetMessagingTimeout(el, 0.5)
        let id = app.bundleIdentifier ?? "pid.\(pid)"
        let role = AX.string(AX.attr(el, kAXRoleAttribute)) ?? "AXUnknown"
        var out = AppTeachElement(
            bundleId: id, appName: app.localizedName ?? "App", role: role, subrole: AX.string(AX.attr(el, kAXSubroleAttribute)),
            title: AX.string(AX.attr(el, kAXTitleAttribute)), description: AX.string(AX.attr(el, kAXDescriptionAttribute)),
            identifier: AX.string(AX.attr(el, kAXIdentifierAttribute)), placeholder: AX.string(AX.attr(el, kAXPlaceholderValueAttribute)),
            secureInput: IsSecureEventInputEnabled()
        )
        // Anything outside the app being recorded is not described further.
        guard id.lowercased() == expected.lowercased() else { return out }
        if let labelEl = AX.element(AX.attr(el, kAXTitleUIElementAttribute)) { out.labelText = AX.string(AX.attr(labelEl, kAXValueAttribute)) ?? AX.string(AX.attr(labelEl, kAXTitleAttribute)) }
        var path: [String] = []
        var menu: [String] = []
        var cursor = AX.element(AX.attr(el, kAXParentAttribute))
        var depth = 0
        while let c = cursor, depth < 12 {
            let r = AX.string(AX.attr(c, kAXRoleAttribute)) ?? ""
            let t = AX.string(AX.attr(c, kAXTitleAttribute)) ?? ""
            if r == "AXMenuItem" || r == "AXMenuBarItem" || r == "AXMenuButton" { if !t.isEmpty { menu.insert(t, at: 0) } }
            else if r != "AXApplication", r != "AXMenu", r != "AXMenuBar", !t.isEmpty { path.insert(t, at: 0) }
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
