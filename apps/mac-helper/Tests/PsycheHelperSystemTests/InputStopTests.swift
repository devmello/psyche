import CoreGraphics
import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import Testing

private final class Posts: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [(type: CGEventType, at: CGPoint, key: Int64, marked: Bool)] = []
    func add(_ e: CGEvent) {
        lock.withLock {
            events.append((e.type, e.location, e.getIntegerValueField(.keyboardEventKeycode), e.getIntegerValueField(.eventSourceUserData) == Input.marker))
        }
    }
    var all: [(type: CGEventType, at: CGPoint, key: Int64, marked: Bool)] { lock.withLock { events } }
    var count: Int { all.count }
    func count(_ t: CGEventType) -> Int { all.filter { $0.type == t }.count }
}

/// The hook is task-local, so each test installs its own and nothing leaks between tests.
@Suite("typing and dragging check the stop right before each post (review 1416, 1418)")
struct InputStopTests {
    @Test func aStopDuringTheChunkGuardPostsNothingMore() async throws {
        let posts = Posts()
        let stop = StopSignal()
        let text = String(repeating: "a", count: 40)  // several chunks
        var guards = 0
        try await Input.$postHook.withValue({ posts.add($0) }) {
            do {
                try await stop.run {
                    try Input.type(text, stop: stop) {
                        guards += 1
                        if guards == 2 { stop.trip() }  // Esc lands while the guard was blocked
                    }
                }
                Issue.record("expected the stop to end typing")
            } catch let e as CapabilityError {
                #expect(e.reason == "user_stopped")
            }
        }
        #expect(guards == 2)
        #expect(posts.count == 2)  // the first chunk's down and up only; the second chunk posted nothing
    }

    @Test func aKeyPressedAfterAStopPostsNothing() async throws {
        let posts = Posts()
        let stop = StopSignal()
        await Input.$postHook.withValue({ posts.add($0) }) {
            do {
                try await stop.run {
                    stop.trip()
                    try Input.key(KeyChord(keyCode: 48, flags: [], name: "tab"), stop: stop)
                }
                Issue.record("expected the stop to end the key")
            } catch let e as CapabilityError {
                #expect(e.reason == "user_stopped")
            } catch { Issue.record("unexpected \(error)") }
        }
        #expect(posts.count == 0)
    }

    private let start = CGPoint(x: 10, y: 10)
    private let end = CGPoint(x: 210, y: 10)

    @Test func aStopMidDragCancelsAndReleasesAtTheStartNotWhereThePointerIs() async throws {
        let posts = Posts()
        let stop = StopSignal()
        await Input.$postHook.withValue({ e in
            posts.add(e)
            if e.type == .leftMouseDragged, posts.count(.leftMouseDragged) == 3 { stop.trip() }  // Esc, mid-drag
        }) {
            do {
                try await stop.run { try Input.drag(from: start, to: end, pid: 100, stop: stop, frontmostPid: { 100 }) }
                Issue.record("expected the stop to end the drag")
            } catch let e as CapabilityError {
                #expect(e.reason == "user_stopped")
            } catch { Issue.record("unexpected \(error)") }
        }
        let events = posts.all
        let up = try #require(events.last)
        #expect(up.type == .leftMouseUp)
        #expect(up.at == start)  // never the midpoint: it may be over another app
        #expect(posts.count(.leftMouseUp) == 1)
        #expect(events.dropLast().last?.type == .leftMouseDragged && events.dropLast().last?.at == start)  // back to the start first
        // A marked Esc (passes the Esc tap) cancels the system drag while the button is still down.
        let escs = events.filter { $0.key == 53 && ($0.type == .keyDown || $0.type == .keyUp) }
        #expect(escs.count == 2)
        #expect(escs.allSatisfy { $0.marked })
        let firstEsc = try #require(events.firstIndex { $0.key == 53 && $0.type == .keyDown })
        #expect(firstEsc < events.count - 1)
        #expect(events[..<firstEsc].allSatisfy { $0.type != .leftMouseUp })
    }

    /// Runs a drag that is stopped mid-way with a modifier held; returns the posted events.
    private func stoppedDrag(frontmost: pid_t?) async -> [(type: CGEventType, at: CGPoint, key: Int64, marked: Bool, flags: CGEventFlags)] {
        final class Log: @unchecked Sendable {
            let lock = NSLock()
            var items: [(type: CGEventType, at: CGPoint, key: Int64, marked: Bool, flags: CGEventFlags)] = []
            var dragged = 0
        }
        let log = Log()
        let stop = StopSignal()
        await Input.$postHook.withValue({ e in
            log.lock.withLock {
                log.items.append((e.type, e.location, e.getIntegerValueField(.keyboardEventKeycode), e.getIntegerValueField(.eventSourceUserData) == Input.marker, e.flags))
                if e.type == .leftMouseDragged { log.dragged += 1; if log.dragged == 3 { stop.trip() } }
            }
        }) {
            _ = try? await stop.run { try Input.drag(from: start, to: end, pid: 100, stop: stop, frontmostPid: { frontmost }) }
        }
        return log.items
    }

    @Test func theCancelEscGoesOnlyWhileTheDragsAppIsFrontmost() async {
        let same = await stoppedDrag(frontmost: 100)
        #expect(same.filter { $0.key == 53 && $0.type == .keyDown }.count == 1)
        let other = await stoppedDrag(frontmost: 200)  // another app came to the front mid-drag
        #expect(other.filter { $0.key == 53 && ($0.type == .keyDown || $0.type == .keyUp) }.isEmpty)
        // Still cancelled: back to the start and released there.
        #expect(other.last?.type == .leftMouseUp)
        #expect(other.last?.at == start)
        let none = await stoppedDrag(frontmost: nil)
        #expect(none.filter { $0.key == 53 && $0.type == .keyDown }.isEmpty)
    }

    @Test func theCancelEventsCarryNoModifiers() async {
        // The drag's own events may carry flags; the cancel sequence must not, whatever the owner holds.
        let events = await stoppedDrag(frontmost: 100)
        let firstEsc = events.firstIndex { $0.key == 53 && $0.type == .keyDown }
        let cancel = events[(firstEsc ?? events.count)...]
        #expect(cancel.count == 4)  // Esc down, Esc up, drag back, release
        #expect(cancel.allSatisfy { $0.flags.intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift]).isEmpty })
        let noEsc = await stoppedDrag(frontmost: 200)
        let tail = noEsc.suffix(2)  // drag back, release
        #expect(tail.allSatisfy { $0.flags.intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift]).isEmpty })
    }

    @Test func aCompletedDragReleasesAtTheEnd() async throws {
        let posts = Posts()
        let stop = StopSignal()
        try await Input.$postHook.withValue({ posts.add($0) }) {
            try await stop.run { try Input.drag(from: start, to: end, pid: 100, stop: stop, frontmostPid: { 100 }) }
        }
        let events = posts.all
        #expect(events.last?.type == .leftMouseUp)
        #expect(events.last?.at == end)
        #expect(events.filter { $0.key == 53 && $0.type == .keyDown }.isEmpty)  // no Esc on success
        #expect(posts.count(.leftMouseUp) == 1)
    }

    @Test func aStopBeforeAClickPostsNoMouseMove() async throws {
        let posts = Posts()
        let stop = StopSignal()
        await Input.$postHook.withValue({ posts.add($0) }) {
            do {
                try await stop.run {
                    stop.trip()
                    try Input.click(at: .zero, count: 1, right: false, flags: [], stop: stop)
                }
                Issue.record("expected the stop to end the click")
            } catch is CapabilityError {} catch { Issue.record("unexpected \(error)") }
        }
        #expect(posts.count == 0)
    }

    @Test func withoutAHookATestRunnerNeverPostsRealInput() {
        #expect(Input.postHook == nil)
        #expect(Input.underTestRunner)
        do {
            try Input.key(KeyChord(keyCode: 48, flags: [], name: "tab"), stop: StopSignal())
            Issue.record("expected the post to be refused")
        } catch let e as CapabilityError {
            #expect(e.reason == "input_blocked_in_tests")
        } catch { Issue.record("unexpected \(error)") }
    }
}
