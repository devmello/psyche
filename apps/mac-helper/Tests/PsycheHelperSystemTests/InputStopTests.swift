import CoreGraphics
import Foundation
import PsycheHelperCore
@testable import PsycheHelperSystem
import Testing

private final class Posts: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.withLock { n += 1 } }
    var count: Int { lock.withLock { n } }
}

/// `Input.postHook` is process-wide: these tests run one at a time.
@Suite("typing checks the stop right before each post (review 1416 #5)", .serialized)
struct InputStopTests {
    @Test func aStopDuringTheChunkGuardPostsNothingMore() async throws {
        let posts = Posts()
        Input.postHook = { _ in posts.bump() }
        defer { Input.postHook = nil }
        let stop = StopSignal()
        let text = String(repeating: "a", count: 40)  // several chunks
        var guards = 0
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
        #expect(guards == 2)
        #expect(posts.count == 2)  // the first chunk's down and up only; the second chunk posted nothing
    }

    @Test func aKeyPressedAfterAStopPostsNothing() async throws {
        let posts = Posts()
        Input.postHook = { _ in posts.bump() }
        defer { Input.postHook = nil }
        let stop = StopSignal()
        do {
            try await stop.run {
                stop.trip()
                try Input.key(KeyChord(keyCode: 48, flags: [], name: "tab"), stop: stop)
            }
            Issue.record("expected the stop to end the key")
        } catch let e as CapabilityError {
            #expect(e.reason == "user_stopped")
        }
        #expect(posts.count == 0)
    }

    @Test func aStopMidDragStillReleasesTheButtonWhereThePointerIs() async throws {
        let types = TypeLog()
        let stop = StopSignal()
        Input.postHook = { e in
            types.add(e.type)
            if e.type == .leftMouseDragged, types.count(.leftMouseDragged) == 3 { stop.trip() }
        }
        defer { Input.postHook = nil }
        do {
            try await stop.run { try Input.drag(from: CGPoint(x: 10, y: 10), to: CGPoint(x: 200, y: 10), stop: stop) }
            Issue.record("expected the stop to end the drag")
        } catch let e as CapabilityError {
            #expect(e.reason == "user_stopped")
        }
        #expect(types.all.last == .leftMouseUp)
        #expect(types.count(.leftMouseDown) == 1)
        #expect(types.count(.leftMouseUp) == 1)
    }

    @Test func aStopBeforeAClickPostsNoMouseMove() async throws {
        let posts = Posts()
        Input.postHook = { _ in posts.bump() }
        defer { Input.postHook = nil }
        let stop = StopSignal()
        do {
            try await stop.run {
                stop.trip()
                try Input.click(at: .zero, count: 1, right: false, flags: [], stop: stop)
            }
            Issue.record("expected the stop to end the click")
        } catch is CapabilityError {}
        #expect(posts.count == 0)
    }

    @Test func withoutAHookATestRunnerNeverPostsRealInput() {
        Input.postHook = nil
        #expect(Input.underTestRunner)
        do {
            try Input.key(KeyChord(keyCode: 48, flags: [], name: "tab"), stop: StopSignal())
            Issue.record("expected the post to be refused")
        } catch let e as CapabilityError {
            #expect(e.reason == "input_blocked_in_tests")
        } catch { Issue.record("unexpected \(error)") }
    }
}

private final class TypeLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [CGEventType] = []
    func add(_ t: CGEventType) { lock.withLock { items.append(t) } }
    var all: [CGEventType] { lock.withLock { items } }
    func count(_ t: CGEventType) -> Int { all.filter { $0 == t }.count }
}
