import ApplicationServices
import CoreGraphics
import Foundation
import PsycheHelperCore

/// Owner input recency for pause-when-unwatched (#272): a listen-only session tap records the
/// last keyboard, mouse or trackpad event that did not come from the helper (`Input.marker`).
/// Until the tap runs there is no owner input on record, so sensitive apps wait (fail closed).
public final class AttentionMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private var last: Date?
    private var tap: CFMachPort?
    private var thread: Thread?

    public init() {}

    public var lastOwnerInput: Date? {
        lock.lock()
        defer { lock.unlock() }
        return last
    }

    public func noteOwnerInput(at date: Date = Date()) {
        lock.lock()
        if last.map({ date > $0 }) ?? true { last = date }
        lock.unlock()
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return tap != nil
    }

    /// Installs the tap on its own run-loop thread. Returns false without Accessibility.
    @discardableResult
    func start() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard tap == nil, AXIsProcessTrusted() else { return tap != nil }
        let types: [CGEventType] = [
            .keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved, .leftMouseDragged,
            .scrollWheel,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let refcon = Unmanaged.passRetained(self).toOpaque()  // the tap lives for the process
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                Unmanaged<AttentionMonitor>.fromOpaque(refcon).takeUnretainedValue().handle(type: type, event: event)
                return Unmanaged.passUnretained(event)
            }, userInfo: refcon
        ) else {
            Unmanaged<AttentionMonitor>.fromOpaque(refcon).release()
            return false
        }
        tap = port
        // Input before the tap existed: the system's idle time, read before the helper posts anything.
        let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
        if idle.isFinite, idle >= 0, last == nil { last = Date().addingTimeInterval(-idle) }
        let box = UncheckedSendable(port)
        let t = Thread { [box] in
            let port = box.value
            let src = CFMachPortCreateRunLoopSource(nil, port, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            CFRunLoopRun()
        }
        t.name = "com.psyche.helper.attention-tap"
        t.qualityOfService = .utility
        thread = t
        t.start()
        return true
    }

    private func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock()
            let port = tap
            lock.unlock()
            if let port { CGEvent.tapEnable(tap: port, enable: true) }
            return
        }
        guard event.getIntegerValueField(.eventSourceUserData) != Input.marker else { return }
        noteOwnerInput()
    }
}
