import Foundation
import PsycheHelperCore
import Testing

// Fakes only: these tests never create a CGEvent tap, so no Accessibility prompt can appear.

private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ s: String) { lock.withLock { items.append(s) } }
    var all: [String] { lock.withLock { items } }
}

private final class Clock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_000_000)
}

private final class FakeHandle: SessionTapHandle, @unchecked Sendable {
    let kind: SessionTapKind
    let log: Log
    let sessions: ComputerSessionLock
    init(kind: SessionTapKind, log: Log, sessions: ComputerSessionLock) {
        self.kind = kind
        self.log = log
        self.sessions = sessions
    }
    func remove() {
        // Recorded with whether a session still held the lock: removal must come after the release.
        log.add("remove \(kind) held=\(sessions.activeSession ?? "none")")
    }
}

private final class FakeInstaller: SessionTapInstaller, @unchecked Sendable {
    let log: Log
    var sessions: ComputerSessionLock!
    var escWorks = true
    var attentionWorks = true
    init(log: Log) { self.log = log }
    func install(_ kind: SessionTapKind) -> (any SessionTapHandle)? {
        if kind == .escStop, !escWorks { log.add("install esc FAILED"); return nil }
        if kind == .attention, !attentionWorks { log.add("install attention FAILED"); return nil }
        // Recorded with whether a session already held the lock: the tap must come first.
        log.add("install \(kind) held=\(sessions.activeSession ?? "none")")
        return FakeHandle(kind: kind, log: log, sessions: sessions)
    }
}

private final class FakeTimers: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var pending: [Int: @Sendable () -> Void] = [:]
    private(set) var delays: [TimeInterval] = []
    private var next = 0
    var scheduler: SessionTapScheduler {
        { [self] delay, fire in
            lock.withLock {
                next += 1
                let id = next
                pending[id] = fire
                delays.append(delay)
                return { [self] in lock.withLock { _ = pending.removeValue(forKey: id) } }
            }
        }
    }
    var armed: Int { lock.withLock { pending.count } }
    func fireAll() {
        let fires = lock.withLock { Array(pending.values) }
        for f in fires { f() }
    }
}

private struct Rig {
    let clock = Clock()
    let log = Log()
    let timers = FakeTimers()
    let installer: FakeInstaller
    let sessions: ComputerSessionLock
    let taps: SessionTaps

    init(idleTimeout: TimeInterval = 120) {
        let clock = clock
        let installer = FakeInstaller(log: log)
        let sessions = ComputerSessionLock(idleTimeout: idleTimeout, now: { clock.now })
        installer.sessions = sessions
        self.installer = installer
        self.sessions = sessions
        taps = SessionTaps(installer: installer, sessions: sessions, schedule: timers.scheduler)
    }
}

@Suite("session-scoped event taps (R2)")
struct SessionTapsTests {
    @Test func nothingIsInstalledUntilASessionBegins() {
        let rig = Rig()
        #expect(rig.log.all.isEmpty)
        #expect(!rig.taps.isInstalled)
    }

    @Test func theEscTapIsInstalledBeforeTheSessionLockIsTaken() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1")
        // `held=none` at install time: the lock did not exist yet when the Esc tap went in.
        #expect(rig.log.all == ["install escStop held=none", "install attention held=none"])
        #expect(rig.sessions.activeSession == "run-1")
        #expect(rig.taps.isInstalled)
    }

    @Test func aSessionNeverStartsWithoutTheEscStop() {
        let rig = Rig()
        rig.installer.escWorks = false
        #expect(throws: CapabilityError.self) { try rig.taps.beginSession("run-1") }
        #expect(rig.sessions.activeSession == nil)  // the lock was never taken
        #expect(!rig.taps.isInstalled)
        // Accessibility granted later: the next session installs it and starts.
        rig.installer.escWorks = true
        #expect(throws: Never.self) { try rig.taps.beginSession("run-2") }
        #expect(rig.sessions.activeSession == "run-2")
    }

    @Test func attentionTapFailureDoesNotBlockTheSessionAndIsRetried() throws {
        let rig = Rig()
        rig.installer.attentionWorks = false
        try rig.taps.beginSession("run-1")
        #expect(rig.sessions.activeSession == "run-1")
        rig.installer.attentionWorks = true
        try rig.taps.beginSession("run-1")
        #expect(rig.log.all.filter { $0.hasPrefix("install attention held") }.count == 1)
    }

    @Test func tapsAreInstalledOnceForManyActions() throws {
        let rig = Rig()
        for _ in 0..<5 { try rig.taps.beginSession("run-1") }
        #expect(rig.log.all.count == 2)
    }

    @Test func releaseRemovesTheTapsAfterTheLockIsGone() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1")
        rig.taps.release("run-1")
        #expect(rig.log.all.suffix(2) == ["remove escStop held=none", "remove attention held=none"])
        #expect(!rig.taps.isInstalled)
        #expect(rig.timers.armed == 0)  // the idle timer is cancelled with the taps
    }

    @Test func releasingAnotherSessionKeepsTheTaps() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1")
        rig.taps.release("some-other-run")
        #expect(rig.taps.isInstalled)
        #expect(rig.sessions.activeSession == "run-1")
    }

    @Test func escStopsTheSessionThenRemovesTheTaps() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1")
        #expect(rig.taps.stopActive() == "run-1")
        #expect(rig.log.all.suffix(2) == ["remove escStop held=none", "remove attention held=none"])
        // The stopped run cannot carry on, and nothing is left installed for it.
        #expect(throws: CapabilityError.self) { try rig.taps.beginSession("run-1") }
        #expect(!rig.taps.isInstalled)
        // A new run reinstalls the Esc stop first.
        try rig.taps.beginSession("run-2")
        #expect(rig.taps.isInstalled)
        #expect(rig.sessions.activeSession == "run-2")
    }

    @Test func aBusyComputerRefusesTheSecondSessionAndKeepsTheFirstsTaps() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1")
        #expect(throws: CapabilityError.self) { try rig.taps.beginSession("run-2") }
        #expect(rig.taps.isInstalled)
        #expect(rig.sessions.activeSession == "run-1")
        #expect(rig.log.all.filter { $0.hasPrefix("remove") }.isEmpty)
    }

    @Test func aRefusedFirstSessionLeavesNoTapsBehind() throws {
        let rig = Rig()
        // A stopped session id is refused by the lock; the taps installed for it must not linger.
        try rig.taps.beginSession("run-1")
        _ = rig.taps.stopActive()
        let before = rig.log.all.count
        #expect(throws: CapabilityError.self) { try rig.taps.beginSession("run-1") }
        #expect(!rig.taps.isInstalled)
        #expect(rig.log.all.dropFirst(before).filter { $0.hasPrefix("remove") }.count == 2)
    }

    @Test func anIdleSessionExpiresAndTheTimerRemovesTheTaps() throws {
        let rig = Rig(idleTimeout: 120)
        try rig.taps.beginSession("run-1")
        #expect(rig.timers.delays == [121])
        // Before the idle timeout: the timer fires, the session is still active, taps stay and it re-arms.
        rig.clock.now = rig.clock.now.addingTimeInterval(60)
        rig.timers.fireAll()
        #expect(rig.taps.isInstalled)
        #expect(rig.timers.armed == 1)
        // Past it: no explicit release ever came; the tap goes away by itself.
        rig.clock.now = rig.clock.now.addingTimeInterval(200)
        rig.timers.fireAll()
        #expect(!rig.taps.isInstalled)
        #expect(rig.timers.armed == 0)
        #expect(rig.log.all.suffix(2) == ["remove escStop held=none", "remove attention held=none"])
    }

    @Test func aNewSessionAfterIdleExpiryGetsFreshTapsFirst() throws {
        let rig = Rig(idleTimeout: 120)
        try rig.taps.beginSession("run-1")
        rig.clock.now = rig.clock.now.addingTimeInterval(500)
        rig.timers.fireAll()
        try rig.taps.beginSession("run-2")
        let installs = rig.log.all.filter { $0.hasPrefix("install escStop") }
        #expect(installs == ["install escStop held=none", "install escStop held=none"])
        #expect(rig.taps.isInstalled)
    }

    @Test func aSessionThatStartsRightAfterAnExpiredOneKeepsItsTaps() throws {
        // The idle timer for run-1 fires late, after run-2 already began: it must not remove run-2's taps.
        let rig = Rig(idleTimeout: 120)
        try rig.taps.beginSession("run-1")
        rig.clock.now = rig.clock.now.addingTimeInterval(200)  // run-1 idle-expired, no timer ran yet
        try rig.taps.beginSession("run-2")
        rig.timers.fireAll()
        #expect(rig.taps.isInstalled)
        #expect(rig.sessions.activeSession == "run-2")
        #expect(rig.log.all.filter { $0.hasPrefix("remove") }.isEmpty)
    }
}

private final class TimeoutInstaller: SessionTapInstaller, @unchecked Sendable {
    let failure: SessionTapFailure
    init(_ failure: SessionTapFailure) { self.failure = failure }
    func install(_ kind: SessionTapKind) -> (any SessionTapHandle)? { nil }
    func failureAfterInstall(_ kind: SessionTapKind) -> SessionTapFailure { failure }
}

@Suite("taps survive a long action (review 1402 #1)")
struct SessionTapsInFlightTests {
    @Test func aLongActionKeepsItsTapsPastTheIdleTimeout() throws {
        let rig = Rig(idleTimeout: 120)
        try rig.taps.beginSession("run-1")
        rig.taps.beginInvocation("run-1")  // e.g. a 20k-character computer.type
        rig.clock.now = rig.clock.now.addingTimeInterval(200)
        rig.timers.fireAll()
        #expect(rig.taps.isInstalled)
        #expect(rig.sessions.activeSession == "run-1")
        #expect(rig.log.all.filter { $0.hasPrefix("remove") }.isEmpty)
        #expect(rig.timers.armed == 1)  // still watching
        // Another run cannot take the computer meanwhile.
        #expect(throws: CapabilityError.self) { try rig.taps.beginSession("run-2") }
        rig.clock.now = rig.clock.now.addingTimeInterval(300)
        rig.timers.fireAll()
        #expect(rig.taps.isInstalled)
        // The action ends: the idle clock restarts from now, then the taps go after the timeout.
        rig.taps.endInvocation("run-1")
        #expect(rig.taps.isInstalled)
        rig.clock.now = rig.clock.now.addingTimeInterval(130)
        rig.timers.fireAll()
        #expect(!rig.taps.isInstalled)
    }

    @Test func endSessionDuringAnActionKeepsTheTapsUntilItEnds() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1")
        rig.taps.beginInvocation("run-1")
        rig.taps.release("run-1")  // computer.end_session arrives mid-action
        #expect(rig.taps.isInstalled)
        #expect(rig.sessions.activeSession == "run-1")
        rig.taps.endInvocation("run-1")
        #expect(!rig.taps.isInstalled)
        #expect(rig.sessions.activeSession == nil)
        #expect(rig.log.all.suffix(2) == ["remove escStop held=none", "remove attention held=none"])
    }

    @Test func aPendingEndSessionStillAppliesWhenTheLastActionEnds() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1")
        rig.taps.beginInvocation("run-1")
        rig.taps.release("run-1")
        rig.taps.beginInvocation("run-1")
        rig.taps.endInvocation("run-1")
        #expect(rig.taps.isInstalled)  // one action still runs
        rig.taps.endInvocation("run-1")
        #expect(!rig.taps.isInstalled)
    }

    @Test func escWhileAnActionRunsStopsTheSessionAtOnce() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1")
        rig.taps.beginInvocation("run-1")
        #expect(rig.taps.stopActive() == "run-1")
        #expect(!rig.taps.isInstalled)
        rig.taps.endInvocation("run-1")  // the stopped action unwinds; nothing comes back
        #expect(rig.sessions.activeSession == nil)
        #expect(throws: CapabilityError.self) { try rig.taps.beginSession("run-1") }
    }

    @Test func theEscCallbackDefersTapRemovalOffItsThread() throws {
        let rig = Rig()
        final class Box: @unchecked Sendable { var work: (@Sendable () -> Void)? }
        let box = Box()
        rig.taps.dispatchReconcile = { box.work = $0 }
        try rig.taps.beginSession("run-1")
        #expect(rig.taps.stopActiveFromTap() == "run-1")
        // Tripped now (the session is gone), but the lock-taking cleanup has not run on this thread.
        #expect(rig.sessions.activeSession == nil)
        #expect(rig.taps.isInstalled)
        box.work?()
        #expect(!rig.taps.isInstalled)
    }

    @Test func anActionIsMarkedInFlightAtomicallyWithTakingTheSession() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1", invocation: true)
        // end_session lands right after the session is taken: the action is already counted.
        rig.taps.release("run-1")
        #expect(rig.taps.isInstalled)
        #expect(rig.sessions.activeSession == "run-1")
        rig.taps.endInvocation("run-1")
        #expect(!rig.taps.isInstalled)
    }

    @Test func aNewActionOnAnEndingSessionIsRefused() throws {
        let rig = Rig()
        try rig.taps.beginSession("run-1", invocation: true)
        rig.taps.release("run-1")
        do { try rig.taps.beginSession("run-1", invocation: true); Issue.record("expected a throw") } catch let e as CapabilityError {
            #expect(e.code == .conflict)
            #expect(e.reason == "session_ending")
        }
        rig.taps.endInvocation("run-1")
        #expect(!rig.taps.isInstalled)
        try rig.taps.beginSession("run-2", invocation: true)  // a new run starts clean
        #expect(rig.sessions.activeSession == "run-2")
    }

    @Test func anActionPastTheHardCapIsStoppedAndTheSessionReleased() throws {
        let clock = Clock()
        let log = Log()
        let installer = FakeInstaller(log: log)
        let sessions = ComputerSessionLock(idleTimeout: 120, maxInFlight: 1800, now: { clock.now })
        installer.sessions = sessions
        let timers = FakeTimers()
        let taps = SessionTaps(installer: installer, sessions: sessions, schedule: timers.scheduler)
        final class Tripped: @unchecked Sendable { var ids: [String] = [] }
        let tripped = Tripped()
        taps.onOverlong = { tripped.ids.append($0) }
        try taps.beginSession("run-1", invocation: true)
        clock.now = clock.now.addingTimeInterval(1700)
        timers.fireAll()
        #expect(taps.isInstalled)  // still within the cap
        #expect(tripped.ids.isEmpty)
        clock.now = clock.now.addingTimeInterval(200)  // 1900 s in flight
        timers.fireAll()
        #expect(tripped.ids == ["run-1"])
        #expect(!taps.isInstalled)
        #expect(sessions.activeSession == nil)
        taps.endInvocation("run-1")  // the stopped action unwinds
        #expect(throws: CapabilityError.self) { try taps.beginSession("run-1") }  // the run cannot carry on
        try taps.beginSession("run-2")  // the computer is free for another run
    }

    /// A rig with a short hard cap; `trips` records the stop in the same log as tap removal, to show the order.
    private struct CapRig {
        let clock = Clock()
        let log = Log()
        let timers = FakeTimers()
        let sessions: ComputerSessionLock
        let taps: SessionTaps
        init() {
            let clock = clock
            let installer = FakeInstaller(log: log)
            sessions = ComputerSessionLock(idleTimeout: 120, maxInFlight: 1800, now: { clock.now })
            installer.sessions = sessions
            taps = SessionTaps(installer: installer, sessions: sessions, schedule: timers.scheduler)
            let log = log
            taps.onOverlong = { log.add("trip \($0)") }
        }
    }

    @Test func anOverlongActionKeepsTheSessionAndEscUntilItIsStopped() throws {
        let rig = CapRig()
        try rig.taps.beginSession("run-1", invocation: true)
        rig.clock.now = rig.clock.now.addingTimeInterval(1801)  // past the cap, the reaper has not run
        #expect(rig.sessions.activeSession == "run-1")  // Esc still consumed and trips
        do { try rig.taps.beginSession("run-2"); Issue.record("expected a throw") } catch let e as CapabilityError {
            #expect(e.reason == "computer_busy")  // another run cannot take over a running action
        }
        #expect(rig.taps.isInstalled)
        rig.timers.fireAll()  // the reaper
        let order = rig.log.all.filter { $0.hasPrefix("trip") || $0.hasPrefix("remove") }
        #expect(order.first == "trip run-1")  // stopped before any tap comes down
        #expect(order.count == 3)
        #expect(!rig.taps.isInstalled)
        #expect(rig.sessions.activeSession == nil)
    }

    @Test func theAfterReapCallbackRunsOutsideTheSessionLock() throws {
        let rig = CapRig()
        let sessions = rig.sessions
        let log = rig.log
        // Reading the session inside the callback would deadlock if the lock were still held.
        rig.taps.afterOverlong = { id in log.add("after \(id) active=\(sessions.activeSession ?? "none")") }
        try rig.taps.beginSession("run-1", invocation: true)
        rig.clock.now = rig.clock.now.addingTimeInterval(1900)
        rig.timers.fireAll()
        let order = rig.log.all.filter { $0.hasPrefix("trip") || $0.hasPrefix("after") }
        #expect(order == ["trip run-1", "after run-1 active=none"])
    }

    @Test func theCapHasItsOwnWakeUp() throws {
        let rig = CapRig()
        try rig.taps.beginSession("run-1", invocation: true)
        #expect(rig.timers.delays.last == 121)
        rig.clock.now = rig.clock.now.addingTimeInterval(1750)
        rig.timers.fireAll()  // an idle-timer wake: re-arms for the 50 s left, not another 121 s
        #expect(rig.timers.delays.last == 50)
    }

    @Test func aReapedSessionReportsTheTimeLimitNotAnEscPress() throws {
        let rig = CapRig()
        try rig.taps.beginSession("run-1", invocation: true)
        rig.clock.now = rig.clock.now.addingTimeInterval(1900)
        rig.timers.fireAll()
        do { try rig.taps.beginSession("run-1"); Issue.record("expected a throw") } catch let e as CapabilityError {
            #expect(e.reason == "action_time_limit")
        }
    }

    @Test func overlappingShortActionsOverThirtyMinutesAreNotReaped() throws {
        let rig = CapRig()
        var live: [Int] = []
        let first = try #require(try rig.taps.beginSession("run-1", invocation: true))
        live.append(first)
        // Each action runs 60 s and overlaps the next by 30 s: the session never idles, no action is old.
        for _ in 0..<80 {
            rig.clock.now = rig.clock.now.addingTimeInterval(30)
            live.append(try #require(try rig.taps.beginSession("run-1", invocation: true)))
            rig.clock.now = rig.clock.now.addingTimeInterval(30)
            rig.taps.endInvocation("run-1", token: live.removeFirst())
            rig.timers.fireAll()
        }
        #expect(rig.log.all.filter { $0.hasPrefix("trip") }.isEmpty)
        #expect(rig.taps.isInstalled)
        #expect(throws: Never.self) { try rig.taps.beginSession("run-1") }
    }

    @Test func aCreationFailureWhileTrustedIsNotRetryable() {
        let sessions = ComputerSessionLock()
        let taps = SessionTaps(installer: TimeoutInstaller(.createFailed), sessions: sessions)
        do { try taps.beginSession("run-1"); Issue.record("expected a throw") } catch let e as CapabilityError {
            #expect(e.reason == "esc_tap_failed")
            #expect(!e.retryable)
        } catch { Issue.record("unexpected \(error)") }
    }

    @Test func anInstallTimeoutIsNotReportedAsMissingAccessibility() {
        let sessions = ComputerSessionLock()
        let timedOut = SessionTaps(installer: TimeoutInstaller(.timeout), sessions: sessions)
        do { try timedOut.beginSession("run-1"); Issue.record("expected a throw") } catch let e as CapabilityError {
            #expect(e.reason == "esc_tap_timeout")
            #expect(e.retryable)
        } catch { Issue.record("unexpected \(error)") }
        let denied = SessionTaps(installer: TimeoutInstaller(.permission), sessions: sessions)
        do { try denied.beginSession("run-1"); Issue.record("expected a throw") } catch let e as CapabilityError {
            #expect(e.reason == "permission_missing")
        } catch { Issue.record("unexpected \(error)") }
    }
}

@Suite("attention seed from the idle clock")
struct AttentionSeedTests {
    private let now = Date(timeIntervalSince1970: 2_000_000)

    @Test func ownerInputBeforeTheHelpersLastPostCounts() {
        let seed = AttentionSeed.ownerInput(now: now, idle: 30, lastHelperPost: now.addingTimeInterval(-3_600))
        #expect(seed == now.addingTimeInterval(-30))
    }

    @Test func aLastEventAtTheHelpersOwnPostIsNotTheOwner() {
        let post = now.addingTimeInterval(-60)
        #expect(AttentionSeed.ownerInput(now: now, idle: 60, lastHelperPost: post) == nil)  // the same instant
        #expect(AttentionSeed.ownerInput(now: now, idle: 59.5, lastHelperPost: post) == nil)  // within the slack
        #expect(AttentionSeed.ownerInput(now: now, idle: 58, lastHelperPost: post) == now.addingTimeInterval(-58))
    }

    @Test func nonsenseIdleValuesAreIgnored() {
        for idle in [-1.0, .infinity, .nan] {
            #expect(AttentionSeed.ownerInput(now: now, idle: idle, lastHelperPost: .distantPast) == nil)
        }
    }
}


@Suite("stop reasons")
struct StopReasonTests {
    @Test func aTimeLimitTripFailsTheActionWithTheTimeLimitNotUserStopped() async {
        let stop = StopSignal()
        do {
            try await stop.run {
                stop.trip(reason: .timeLimit)
                try stop.check()
            }
            Issue.record("expected a throw")
        } catch let e as CapabilityError {
            #expect(e.reason == "action_time_limit")
        } catch { Issue.record("unexpected \(error)") }
    }

    @Test func anEscTripStillReportsUserStopped() async {
        let stop = StopSignal()
        do {
            try await stop.run {
                stop.trip()
                try stop.check()
            }
            Issue.record("expected a throw")
        } catch let e as CapabilityError {
            #expect(e.reason == "user_stopped")
        } catch { Issue.record("unexpected \(error)") }
    }
}
