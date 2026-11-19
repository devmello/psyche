import Foundation
@testable import PsycheHelperCore
import PsycheProtocol
import PsycheWire
import Testing

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.withLock { n += 1 } }
    var value: Int { lock.withLock { n } }
}

private func tempHome() throws -> String {
    let home = NSTemporaryDirectory() + "psyche-wake-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: home + "/run", withIntermediateDirectories: true)
    return home
}

/// Atomic replace, like the Gateway: a new inode each time.
private func write(_ path: String, _ text: String) throws {
    try text.write(toFile: path, atomically: true, encoding: .utf8)
}

private func eventually(_ timeout: TimeInterval = 3, _ cond: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if cond() { return true }
        try? await _Concurrency.Task.sleep(nanoseconds: 50_000_000)
    }
    return cond()
}

private struct NoPreflight: PermissionPreflight {
    func isGranted(_ permission: TCCPermission) -> Bool { true }
}

@Suite("gateway-up wake only on a real restart (review 1402 #5)")
struct GatewayUpWakeTests {
    private func daemon(_ home: String) -> NodeDaemon {
        NodeDaemon(
            identity: DeviceIdentity(), registry: CapabilityRegistry([]), preflight: NoPreflight(),
            log: HelperLog(echo: { _ in }), environment: ["PSYCHE_HOME": home])
    }

    /// Starts a wait, runs `during` after the one-second debounce, returns whether the wait ended early.
    private func woken(_ d: NodeDaemon, denied: Bool, during: @escaping @Sendable () throws -> Void) async throws -> Bool {
        async let early: Bool = _Concurrency.Task.detached { d.sleepUnlessStopped(3, denied: denied) }.value
        try await _Concurrency.Task.sleep(nanoseconds: 1_300_000_000)
        try during()
        d.gatewayMayBeUp()
        let result = await early
        d.stop()
        return result
    }

    @Test func unrelatedFilesInRunDoNotWake() async throws {
        let home = try tempHome()
        try write(home + "/run/node-socket", "/tmp/a.sock")
        let d = daemon(home)
        let started = Date()
        let early = try await woken(d, denied: false) {
            try write(home + "/run/update-progress.json", "{}")
            try write(home + "/run/updater.json", "{}")
        }
        #expect(!early)
        #expect(Date().timeIntervalSince(started) >= 2.9)
    }

    @Test func aRewrittenSocketPointerWakes() async throws {
        let home = try tempHome()
        try write(home + "/run/node-socket", "/tmp/a.sock")
        let early = try await woken(daemon(home), denied: false) { try write(home + "/run/node-socket", "/tmp/b.sock") }
        #expect(early)
    }

    @Test func aSocketPointerThatAppearsWakes() async throws {
        let home = try tempHome()
        let early = try await woken(daemon(home), denied: false) { try write(home + "/run/node-socket", "/tmp/b.sock") }
        #expect(early)
    }

    @Test func aDeniedWaitIgnoresANewSocketPointer() async throws {
        let home = try tempHome()
        try write(home + "/run/node-socket", "/tmp/a.sock")
        try write(home + "/run/handshake.secret", "one")
        let early = try await woken(daemon(home), denied: true) { try write(home + "/run/node-socket", "/tmp/b.sock") }
        #expect(!early)
    }

    @Test func aDeniedWaitEndsOnANewHandshakeSecret() async throws {
        let home = try tempHome()
        try write(home + "/run/node-socket", "/tmp/a.sock")
        try write(home + "/run/handshake.secret", "one")
        let early = try await woken(daemon(home), denied: true) { try write(home + "/run/handshake.secret", "two") }
        #expect(early)
    }
}

@Suite("early wake (review 1415 #6)")
struct GatewayUpEarlyWakeTests {
    private func daemon(_ home: String) -> NodeDaemon {
        NodeDaemon(
            identity: DeviceIdentity(), registry: CapabilityRegistry([]), preflight: NoPreflight(),
            log: HelperLog(echo: { _ in }), environment: ["PSYCHE_HOME": home])
    }

    @Test func aRestartInTheFirstSecondOfAWaitIsNotDropped() async throws {
        let home = try tempHome()
        try write(home + "/run/node-socket", "/tmp/a.sock")
        let d = daemon(home)
        async let early: Bool = _Concurrency.Task.detached { d.sleepUnlessStopped(5) }.value
        try await _Concurrency.Task.sleep(nanoseconds: 150_000_000)  // well inside the first second
        try write(home + "/run/node-socket", "/tmp/b.sock")
        d.gatewayMayBeUp()
        let started = Date()
        #expect(await early)
        #expect(Date().timeIntervalSince(started) < 2)
    }

    @Test func aRestartThatLandedDuringTheFailedAttemptEndsTheWaitAtOnce() throws {
        let home = try tempHome()
        let d = daemon(home)
        let before = NodeDaemon.RunFingerprint.read(environment: ["PSYCHE_HOME": home])  // taken before the attempt
        try write(home + "/run/node-socket", "/tmp/b.sock")  // the Gateway came up while the attempt failed
        let started = Date()
        #expect(d.sleepUnlessStopped(30, baseline: before))
        let took = Date().timeIntervalSince(started)
        #expect(took >= NodeDaemon.minRetryGap - 0.02)  // not a back-to-back reconnect
        #expect(took < 2)
    }
}

@Suite("run/ watcher re-opens after the directory is recreated (review 1402 #5)")
struct GatewayUpWatcherTests {
    @Test func aChangeInRunIsReported() async throws {
        let home = try tempHome()
        let hits = Counter()
        let watcher = GatewayUpWatcher(environment: ["PSYCHE_HOME": home], retryInterval: 0.1) { hits.bump() }
        try write(home + "/run/node-socket", "x")
        #expect(await eventually { hits.value > 0 })
        withExtendedLifetime(watcher) {}
    }

    @Test func itWaitsForRunToAppearWhenItIsMissingAtStart() async throws {
        let home = NSTemporaryDirectory() + "psyche-wake-\(UUID().uuidString)"  // no run/ yet
        let hits = Counter()
        let watcher = GatewayUpWatcher(environment: ["PSYCHE_HOME": home], retryInterval: 0.1) { hits.bump() }
        try? await _Concurrency.Task.sleep(nanoseconds: 300_000_000)
        try FileManager.default.createDirectory(atPath: home + "/run", withIntermediateDirectories: true)
        #expect(await eventually { hits.value > 0 })  // opened, and told the daemon to look
        let before = hits.value
        try write(home + "/run/node-socket", "x")
        #expect(await eventually { hits.value > before })
        withExtendedLifetime(watcher) {}
    }

    @Test func itKeepsWatchingWhenRunIsDeletedAndRecreated() async throws {
        let home = try tempHome()
        let hits = Counter()
        let watcher = GatewayUpWatcher(environment: ["PSYCHE_HOME": home], retryInterval: 0.1) { hits.bump() }
        try FileManager.default.removeItem(atPath: home + "/run")
        try? await _Concurrency.Task.sleep(nanoseconds: 300_000_000)
        try FileManager.default.createDirectory(atPath: home + "/run", withIntermediateDirectories: true)
        try? await _Concurrency.Task.sleep(nanoseconds: 500_000_000)
        let before = hits.value
        try write(home + "/run/node-socket", "after recreate")
        #expect(await eventually { hits.value > before })
        withExtendedLifetime(watcher) {}
    }
}
