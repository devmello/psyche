import CoreFoundation
import Foundation
@testable import PsycheHelperSystem
import Testing

/// The live source once deadlocked: `start()` held its state lock across the wait for the run-loop
/// thread, which needed that lock before it could signal readiness. `RunLoopThread` is the part
/// that waits; these tests run it the way the source does, with a stub in place of AX (the install
/// closure only adds a timer source, standing in for the observer and the tap).
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.withLock { n += 1 } }
    var value: Int { lock.withLock { n } }
}

@Suite("run-loop thread for the app recorder", .serialized)
struct RunLoopThreadTests {
    /// Fails (instead of hanging the suite) if `body` does not finish in time.
    private func finishes(within seconds: Double, _ body: @escaping @Sendable () -> Void) -> Bool {
        let done = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            body()
            done.signal()
        }
        return done.wait(timeout: .now() + seconds) == .success
    }

    @Test func startReturnsWhileTheCallerHoldsItsOwnLock() {
        let fails = Counter()
        let ok = finishes(within: 10) {
            let stateLock = NSLock()
            for _ in 0..<50 {
                let t = RunLoopThread(name: "test.teach.runloop")
                let counter = Counter()
                // The caller holds its state lock across start(), as the source's state lock once was.
                let up = stateLock.withLock {
                    t.start { loop in
                        let timer = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 100, 0, 0, 0) { _ in }
                        CFRunLoopAddTimer(loop, timer, .commonModes)
                        counter.bump()
                    }
                }
                #expect(up)
                #expect(counter.value == 1)
                t.stop()
                t.stop()  // twice is fine
                if !t.waitUntilExited(timeout: 5) { fails.bump() }
            }
        }
        #expect(ok, "RunLoopThread.start or stop hung")
        #expect(fails.value == 0, "a thread did not exit after stop")
    }

    @Test func manyStartsAndStopsAtOnceNeitherHangNorCrash() {
        let ok = finishes(within: 20) {
            let group = DispatchGroup()
            for i in 0..<40 {
                group.enter()
                DispatchQueue.global().async {
                    let t = RunLoopThread(name: "test.teach.runloop.\(i)")
                    if t.start(install: { _ in }) { t.stop() }
                    group.leave()
                }
            }
            group.wait()
        }
        #expect(ok, "concurrent start/stop hung")
    }

    @Test func aStopBeforeAnyStartDoesNothing() {
        let t = RunLoopThread(name: "test.teach.runloop.idle")
        t.stop()
    }

    @Test func aStopRightAfterStartIsNeverLost() {
        let fails = Counter()
        let ok = finishes(within: 30) {
            for _ in 0..<100 {
                let t = RunLoopThread(name: "test.teach.runloop.race")
                if t.start(install: { loop in
                    let timer = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 100, 0, 0, 0) { _ in }
                    CFRunLoopAddTimer(loop, timer, .commonModes)
                }) {
                    t.stop()  // before the loop necessarily ran
                    if !t.waitUntilExited(timeout: 5) { fails.bump() }
                }
            }
        }
        #expect(ok)
        #expect(fails.value == 0, "a stop was lost")
    }

    @Test func teardownRunsOnTheThreadWhenItEnds() {
        let counter = Counter()
        let t = RunLoopThread(name: "test.teach.runloop.teardown")
        let up = t.start(install: { _ in }, teardown: { _ in counter.bump() })
        #expect(up)
        t.stop()
        #expect(t.waitUntilExited(timeout: 5))
        #expect(counter.value == 1)
    }

    @Test func aStartThatTimesOutEndsTheThreadAndStillTearsDown() {
        let installed = Counter()
        let tornDown = Counter()
        let t = RunLoopThread(name: "test.teach.runloop.slow")
        // Install is slower than the timeout: start gives up, the thread finishes and cleans up by itself.
        let up = t.start(
            timeout: 0.1,
            install: { _ in
                Thread.sleep(forTimeInterval: 0.5)
                installed.bump()
            },
            teardown: { _ in tornDown.bump() }
        )
        #expect(!up)
        #expect(t.waitUntilExited(timeout: 5), "the cancelled thread must exit")
        #expect(installed.value == 1 && tornDown.value == 1, "what was installed is torn down")
    }
}
