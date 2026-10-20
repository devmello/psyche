import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import PsycheHelperCore

/// Reads the target of an owner input from the accessibility tree: role, subrole, title or
/// description, identifier, app and window title. Never `AXValue` (field contents).
enum LiveTeachAX {
    static var systemWide: AXUIElement {
        let s = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(s, 0.5)
        return s
    }

    static func target(at point: CGPoint) -> TeachTargetInfo? {
        var el: AXUIElement?
        guard AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &el) == .success, let el else { return nil }
        return info(el)
    }

    static func focused() -> TeachTargetInfo? {
        guard let el: AXUIElement = attr(systemWide, kAXFocusedUIElementAttribute) else { return nil }
        return info(el)
    }

    static func attr<T>(_ el: AXUIElement, _ name: String) -> T? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
        return v as? T
    }

    static func info(_ el: AXUIElement) -> TeachTargetInfo? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(el, &pid) == .success, let app = NSRunningApplication(processIdentifier: pid) else { return nil }
        let role: String? = attr(el, kAXRoleAttribute)
        let title: String? = attr(el, kAXTitleAttribute)
        let desc: String? = attr(el, kAXDescriptionAttribute)
        let window: AXUIElement? = attr(el, kAXWindowAttribute)
        var target = TeachTargetInfo(
            app: app.bundleIdentifier ?? "pid.\(pid)", appName: app.localizedName ?? "App", window: window.flatMap { attr($0, kAXTitleAttribute) },
            role: role, subrole: attr(el, kAXSubroleAttribute), label: (title?.isEmpty == false ? title : nil) ?? desc,
            identifier: attr(el, kAXIdentifierAttribute)
        )
        // Secure Event Input (a password field anywhere has focus) marks the target secure too.
        if IsSecureEventInputEnabled() { target.role = "AXSecureTextField" }
        return target
    }
}

/// Listen-only session tap for teach mode: owner clicks and key presses, never the helper's own
/// events (`Input.marker`). AX lookups run on a serial queue so the tap never stalls input.
/// Keystrokes typed while Secure Event Input is on never reach a tap at all.
final class TeachRecorder: @unchecked Sendable {
    private let onInput: @Sendable (TeachInput, Date) -> Void
    private let queue = DispatchQueue(label: "com.psyche.helper.teach")
    private let lock = NSLock()
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var refcon: UnsafeMutableRawPointer?

    init(onInput: @escaping @Sendable (TeachInput, Date) -> Void) { self.onInput = onInput }

    func start() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard tap == nil, AXIsProcessTrusted() else { return tap != nil }
        let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .keyDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let ref = Unmanaged.passRetained(self).toOpaque()
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                if let refcon { Unmanaged<TeachRecorder>.fromOpaque(refcon).takeUnretainedValue().handle(type, event) }
                return Unmanaged.passUnretained(event)
            }, userInfo: ref
        ) else {
            Unmanaged<TeachRecorder>.fromOpaque(ref).release()
            return false
        }
        tap = port
        refcon = ref
        let ready = DispatchSemaphore(value: 0)
        let t = Thread { [weak self, port] in
            let src = CFMachPortCreateRunLoopSource(nil, port, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            self?.lock.withLock { self?.runLoop = CFRunLoopGetCurrent() }
            ready.signal()
            CFRunLoopRun()
        }
        t.name = "com.psyche.helper.teach-tap"
        t.qualityOfService = .userInitiated
        t.start()
        ready.wait()
        return true
    }

    func stop() {
        lock.lock()
        let port = tap, loop = runLoop, ref = refcon
        tap = nil
        runLoop = nil
        refcon = nil
        lock.unlock()
        if let port {
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
        }
        if let loop { CFRunLoopStop(loop) }
        // Pending lookups on the queue may still use self; release after them.
        if let ref { queue.async { Unmanaged<TeachRecorder>.fromOpaque(ref).release() } }
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let port = lock.withLock({ tap }) { CGEvent.tapEnable(tap: port, enable: true) }
            return
        }
        guard event.getIntegerValueField(.eventSourceUserData) != Input.marker else { return }
        let now = Date()
        switch type {
        case .leftMouseDown, .rightMouseDown:
            let point = event.location
            let button = type == .rightMouseDown ? 1 : 0
            let count = Int(event.getIntegerValueField(.mouseEventClickState))
            queue.async { [onInput] in onInput(.click(button: button, clickCount: count, target: LiveTeachAX.target(at: point)), now) }
        case .keyDown:
            let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
            let flags = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).rawValue
            var length = 0
            var chars = [UniChar](repeating: 0, count: 8)
            event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &length, unicodeString: &chars)
            let text = String(utf16CodeUnits: chars, count: length)
            queue.async { [onInput] in onInput(.key(keyCode: code, characters: text, flags: flags, target: LiveTeachAX.focused()), now) }
        default:
            break
        }
    }
}
