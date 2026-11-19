import AppKit
import CoreGraphics
import Foundation
import PsycheHelperCore

/// Synthetic input through the HID event tap (spike 04: `CGEventPostToPid` was ignored by Finder).
/// Every event carries `marker` in `eventSourceUserData`, so the Esc stop tap never treats the
/// helper's own keystrokes as the user's.
enum Input {
    static let marker: Int64 = 0x5053_5943_4845  // "PSYCHE"

    /// When the helper last posted an event, so owner input can be told from the helper's own in the system's idle time.
    static let lastPost = PostClock()

    final class PostClock: @unchecked Sendable {
        private let lock = NSLock()
        private var at = Date.distantPast
        func note() { lock.withLock { at = Date() } }
        var value: Date { lock.withLock { at } }
    }

    /// Tests replace the poster so no event reaches the system. Task-local, so one test's hook cannot
    /// leak into another test or into a concurrent task.
    @TaskLocal static var postHook: (@Sendable (CGEvent) -> Void)?

    /// True when the process is a test runner: real input must never be posted from a test, since it
    /// would drive the owner's mouse and keyboard. Debug builds only: a release helper has no such
    /// switch, so no environment variable can turn computer use off.
    static let underTestRunner: Bool = {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        if env["PSYCHE_NO_REAL_INPUT"] != nil || env["XCTestConfigurationFilePath"] != nil || env["XCTestBundlePath"] != nil { return true }
        if NSClassFromString("XCTestCase") != nil { return true }
        if Bundle.allBundles.contains(where: { $0.bundlePath.hasSuffix(".xctest") }) { return true }
        let name = ProcessInfo.processInfo.processName
        return name.contains("xctest") || name.contains("swiftpm-testing-helper")
        #else
        return false
        #endif
    }()

    static let blockedInTests = CapabilityError.unavailable("input_blocked_in_tests", "Real input is not posted from a test runner")

    private static func post(_ event: CGEvent?) throws {
        guard let event else { return }
        if postHook == nil, underTestRunner { throw blockedInTests }
        lastPost.note()
        event.setIntegerValueField(.eventSourceUserData, value: marker)
        if let postHook { postHook(event) } else { event.post(tap: .cghidEventTap) }
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

    static func move(to p: CGPoint) throws {
        try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    }

    static func click(at p: CGPoint, count: Int, right: Bool, flags: CGEventFlags, stop: StopSignal) throws {
        let src = source
        try stop.check()
        try move(to: p)
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
            try stop.check()
            try post(down)
            try pause(20, stop: stop)
            try stop.check()
            try post(up)
            if i < count { try pause(40, stop: stop) }
        }
    }

    /// `pid` is the app the drag is in; `frontmostPid` says which app is frontmost now (tests replace it).
    static func drag(
        from a: CGPoint, to b: CGPoint, pid: pid_t, stop: StopSignal,
        frontmostPid: () -> pid_t? = { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    ) throws {
        let src = source
        try stop.check()
        try move(to: a)
        try pause(30, stop: stop)
        try stop.check()
        try post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left))
        // The button is down from here. If the drag does not finish (a stop included) it is CANCELLED,
        // never dropped: the pointer may be over another app that no tier check covered. A marked Esc
        // (it passes the Esc tap) cancels the system drag, then the pointer goes back to the start and
        // releases there, where a drop is a no-op. The Esc goes only if the drag's app is still frontmost:
        // otherwise it would land in another app. Cancel events carry no modifiers, so a key the owner
        // holds cannot turn the Esc into Force Quit (Option-Command-Esc) or the release into a copy drag.
        var completed = false
        defer {
            if !completed {
                if frontmostPid() == pid {
                    for down in [true, false] {
                        let esc = CGEvent(keyboardEventSource: src, virtualKey: 53, keyDown: down)
                        esc?.flags = []
                        try? post(esc)
                    }
                }
                let back = CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: a, mouseButton: .left)
                back?.flags = []
                try? post(back)
                let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: a, mouseButton: .left)
                up?.flags = []
                try? post(up)
            }
        }
        let steps = 12
        for i in 1...steps {
            try pause(15, stop: stop)
            let t = Double(i) / Double(steps)
            let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            try post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
        }
        try pause(30, stop: stop)
        try post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left))
        completed = true
    }

    static func scroll(at p: CGPoint, dx: Int32, dy: Int32, stop: StopSignal) throws {
        try stop.check()
        try move(to: p)
        try pause(30, stop: stop)
        // Send in small steps so Esc can interrupt long scrolls.
        var remainingY = dy
        var remainingX = dx
        while remainingY != 0 || remainingX != 0 {
            let sy = max(-5, min(5, remainingY))
            let sx = max(-5, min(5, remainingX))
            try post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: sy, wheel2: sx, wheel3: 0))
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
            try stop.check()  // an Esc during the pause or the focus check posts nothing more
            try post(e)
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
                try stop.check()  // the guard can block in AX: a stop that landed meanwhile posts nothing
                let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
                chunk.withUnsafeBufferPointer { buf in
                    e?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
                }
                try post(e)
            }
            try pause(15, stop: stop)
        }
    }
}

/// Global Esc stop (J5; security section 12): an active event tap that consumes a bare Esc while a
/// computer-use session is running, so injected content cannot use it to dismiss dialogs, and trips
/// the stop signal. `SessionTaps` installs it before a session takes its lock and removes it after
/// the session ends, so no keystroke is filtered outside a session. Requires Accessibility (one
/// grant covers listen and post, spike 04).
enum EscStopTap {
    /// A bare Esc (no modifiers) typed by the owner: not the helper's own event.
    static func isOwnerEsc(keyCode: Int64, flags: CGEventFlags, userData: Int64) -> Bool {
        keyCode == 53 && userData != Input.marker && flags.intersection([.maskCommand, .maskShift, .maskAlternate, .maskControl]).isEmpty
    }

    static func install(
        stop: StopSignal, isActive: @escaping @Sendable () -> Bool, onStop: @escaping @Sendable () -> Void
    ) -> Result<RunLoopEventTap, RunLoopEventTap.InstallFailure> {
        RunLoopEventTap.create(
            place: .headInsertEventTap, options: .defaultTap, types: [.keyDown], qos: .userInteractive, name: "com.psyche.helper.esc-tap"
        ) { type, event in
            guard type == .keyDown,
                  isOwnerEsc(
                    keyCode: event.getIntegerValueField(.keyboardEventKeycode), flags: event.flags,
                    userData: event.getIntegerValueField(.eventSourceUserData)),
                  isActive()
            else { return Unmanaged.passUnretained(event) }
            stop.trip()
            onStop()
            return nil  // consumed
        }
    }
}
