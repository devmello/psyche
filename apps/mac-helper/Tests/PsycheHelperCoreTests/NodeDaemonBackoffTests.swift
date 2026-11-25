import Foundation
@testable import PsycheHelperCore
import PsycheProtocol
import PsycheWire
import Testing

@Suite("node daemon reconnect schedule (R2)")
struct NodeDaemonBackoffTests {
    @Test func theScheduleDoublesFromHalfASecondAndCapsAtThirty() {
        let b = NodeDaemon.Backoff()
        let delays = (0..<9).map { b.delay(afterFailures: $0) }
        #expect(delays == [0.5, 1, 2, 4, 8, 16, 30, 30, 30])
        #expect(b.delay(afterFailures: 10_000) == 30)
    }

    @Test func jitterStaysBetweenHalfAndAllOfTheDelay() {
        let b = NodeDaemon.Backoff()
        #expect(b.jittered(30, random: 0) == 15)
        #expect(b.jittered(30, random: 0.5) == 22.5)
        #expect(b.jittered(30, random: 0.999999) < 30)
        // Out-of-range input is clamped, never negative or past the delay.
        #expect(b.jittered(8, random: -3) == 4)
        #expect(b.jittered(8, random: 9) == 8)
        for step in 0..<12 {
            let base = b.delay(afterFailures: step)
            for r in stride(from: 0.0, to: 1.0, by: 0.1) {
                let j = b.jittered(base, random: r)
                #expect(j >= base / 2 && j <= base && j <= b.max)
            }
        }
    }

    @Test func aSessionThatDropsRightAfterPairingBacksOffAndAHealthyOneResets() {
        let b = NodeDaemon.Backoff()
        var failures = 0
        var delays: [TimeInterval] = []
        for _ in 0..<8 {
            let step = NodeDaemon.afterServed(failures: failures, lasted: 0.2, backoff: b)
            failures = step.failures
            delays.append(step.delay)
        }
        #expect(delays == [0.5, 1, 2, 4, 8, 16, 30, 30])
        // Control: a session that held for a while starts the schedule over.
        let healthy = NodeDaemon.afterServed(failures: failures, lasted: 60, backoff: b)
        #expect(healthy.failures == 0 && healthy.delay == 0.5)
    }

    private func daemon(home: String = NSTemporaryDirectory()) -> NodeDaemon {
        NodeDaemon(
            identity: DeviceIdentity(), registry: CapabilityRegistry([]), preflight: NoPreflight(), log: HelperLog(echo: { _ in }),
            environment: ["PSYCHE_HOME": home])
    }

    @Test func aWaitEndsEarlyWhenTheGatewayComesUp() async {
        let home = NSTemporaryDirectory() + "psyche-daemon-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: home + "/run", withIntermediateDirectories: true)
        let d = daemon(home: home)
        let started = Date()
        async let woken: Bool = _Concurrency.Task.detached { d.sleepUnlessStopped(30) }.value
        try? await _Concurrency.Task.sleep(nanoseconds: 1_300_000_000)  // past the one-second debounce
        try? "/tmp/new.sock".write(toFile: home + "/run/node-socket", atomically: true, encoding: .utf8)  // the Gateway restarted
        d.gatewayMayBeUp()
        #expect(await woken)
        #expect(Date().timeIntervalSince(started) < 10)
    }

    @Test func aGatewaySignalThatArrivesTooSoonOrWhileConnectedIsIgnored() async {
        let d = daemon()
        d.gatewayMayBeUp()  // not waiting: dropped, must not cut the next wait short
        let t0 = Date()
        async let woken: Bool = _Concurrency.Task.detached { d.sleepUnlessStopped(0.6) }.value
        try? await _Concurrency.Task.sleep(nanoseconds: 100_000_000)
        d.gatewayMayBeUp()  // inside the first second of the wait: dropped
        #expect(await woken == false)
        #expect(Date().timeIntervalSince(t0) >= 0.55)
    }

    @Test func stopEndsAWaitAtOnce() async {
        let d = daemon()
        let started = Date()
        async let woken: Bool = _Concurrency.Task.detached { d.sleepUnlessStopped(30) }.value
        try? await _Concurrency.Task.sleep(nanoseconds: 100_000_000)
        d.stop()
        #expect(await woken == false)
        #expect(Date().timeIntervalSince(started) < 10)
    }
}

private struct NoPreflight: PermissionPreflight {
    func isGranted(_ permission: TCCPermission) -> Bool { true }
}
