import AppKit
import CoreGraphics
import Foundation
import PsycheHelperCore

/// Synthetic input through the HID event tap (spike 04: `CGEventPostToPid` was ignored by Finder).
/// Every event carries `marker` in `eventSourceUserData`, so the Esc stop tap never treats the
/// helper's own keystrokes as the user's.
enum Input {
    static let marker: Int64 = 0x5053_5943_4845  // "PSYCHE"

    private static func post(_ event: CGEvent?) {
        guard let event else { return }
        event.setIntegerValueField(.eventSourceUserData, value: marker)
        event.post(tap: .cghidEventTap)
    }

    private static var source: CGEventSource? { CGEventSource(stateID: .hidSystemState) }

    /// Sleeps in ≤ 20 ms slices, checking the stop signal (Esc within 200 ms, J5).
    static func pause(_ ms: Int, stop: StopSignal) throws {
        var left = ms
        while left > 0 {
            try stop.check()
            let slice = min(20, left)
            usleep(useconds_t(slice * 1000))
            left -= slice
        }
        try stop.check()
    }

    static func move(to p: CGPoint) {
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    }

    static func click(at p: CGPoint, count: Int, right: Bool, flags: CGEventFlags, stop: StopSignal) throws {
        let src = source
        move(to: p)
        try pause(30, stop: stop)
        let (downType, upType, button): (CGEventType, CGEventType, CGMouseButton) =
            right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
        for i in 1...max(1, count) {
            let down = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: p, mouseButton: button)
            let up = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: p, mouseButton: button)
            for e in [down, up] {
                e?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
                e?.flags = flags
            }
            post(down)
            try pause(20, stop: stop)
            post(up)
            if i < count { try pause(40, stop: stop) }
        }
    }

    static func drag(from a: CGPoint, to b: CGPoint, stop: StopSignal) throws {
        let src = source
        move(to: a)
        try pause(30, stop: stop)
        post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left))
        let steps = 12
        for i in 1...steps {
            try pause(15, stop: stop)
            let t = Double(i) / Double(steps)
            let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
        }
        try pause(30, stop: stop)
        post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left))
    }

    static func scroll(at p: CGPoint, dx: Int32, dy: Int32, stop: StopSignal) throws {
        move(to: p)
        try pause(30, stop: stop)
        // Send in small steps so Esc can interrupt long scrolls.
        var remainingY = dy
        var remainingX = dx
        while remainingY != 0 || remainingX != 0 {
            let sy = max(-5, min(5, remainingY))
            let sx = max(-5, min(5, remainingX))
            post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: sy, wheel2: sx, wheel3: 0))
            remainingY -= sy
            remainingX -= sx
            try pause(15, stop: stop)
        }
    }

    static func key(_ chord: KeyChord, stop: StopSignal) throws {
        let src = source
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: chord.keyCode, keyDown: down)
            e?.flags = chord.flags
            post(e)
            try pause(20, stop: stop)
        }
    }

    /// Free text as unicode-string events (spike 04: fine for text, not for typeahead or named keys).
    /// Tab and newlines are sent as keycode events. `guardChunk` runs before every chunk and key, so
    /// a focus change (Tab into a password field, a window stealing focus) stops typing.
    static func type(_ text: String, stop: StopSignal, guardChunk: () throws -> Void) throws {
        var segment = ""
        func flush() throws {
            guard !segment.isEmpty else { return }
            try typeSegment(segment, stop: stop, guardChunk: guardChunk)
            segment = ""
        }
        for ch in text {
            switch ch {
            case "\t", "\n", "\r\n", "\r":
                try flush()
                try guardChunk()
                try key(KeyChord(keyCode: ch == "\t" ? 48 : 36, flags: [], name: ch == "\t" ? "tab" : "return"), stop: stop)
            default:
                if ch.unicodeScalars.allSatisfy({ CharacterSet.controlCharacters.contains($0) }) { continue }
                segment.append(ch)
            }
        }
        try flush()
    }

    private static func typeSegment(_ text: String, stop: StopSignal, guardChunk: () throws -> Void) throws {
        let src = source
        for chunk in TypingChunks.split(text) {
            try guardChunk()
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
                chunk.withUnsafeBufferPointer { buf in
                    e?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
                }
                post(e)
            }
            try pause(15, stop: stop)
        }
    }
}

/// Global Esc stop (J5; security §12): an active event tap that consumes a bare Esc while a
/// computer-use session is running, so injected content cannot use it to dismiss dialogs, and trips
/// the stop signal. Requires Accessibility (one grant covers listen and post, spike 04).
final class EscStopTap: @unchecked Sendable {
    private let stop: StopSignal
    private let isActive: @Sendable () -> Bool
    private let onStop: @Sendable () -> Void
    private var tap: CFMachPort?
    private var thread: Thread?

    init(stop: StopSignal, isActive: @escaping @Sendable () -> Bool, onStop: @escaping @Sendable () -> Void) {
        self.stop = stop
        self.isActive = isActive
        self.onStop = onStop
    }

    /// Installs the tap on its own run-loop thread. Returns false without Accessibility.
    @discardableResult
    func start() -> Bool {
        guard tap == nil, AXIsProcessTrusted() else { return false }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        let refcon = Unmanaged.passRetained(self).toOpaque()  // the tap lives for the process
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let me = Unmanaged<EscStopTap>.fromOpaque(refcon).takeUnretainedValue()
                return me.handle(type: type, event: event)
            }, userInfo: refcon
        ) else { return false }
        tap = port
        let box = UncheckedSendable(port)
        let t = Thread { [box] in
            let port = box.value
            let src = CFMachPortCreateRunLoopSource(nil, port, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            CFRunLoopRun()
        }
        t.name = "com.psyche.helper.esc-tap"
        t.qualityOfService = .userInteractive
        thread = t
        t.start()
        return true
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        guard type == .keyDown,
              event.getIntegerValueField(.keyboardEventKeycode) == 53,
              event.getIntegerValueField(.eventSourceUserData) != Input.marker,
              event.flags.intersection([.maskCommand, .maskShift, .maskAlternate, .maskControl]).isEmpty,
              isActive()
        else { return Unmanaged.passUnretained(event) }
        stop.trip()
        onStop()
        return nil  // consumed
    }
}
