import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheShared
@testable import PsycheStore

@MainActor
private final class FakeAudio: SilentAudio {
    var isPlaying = false
    var onEvent: (@MainActor (SilentAudioEvent) -> Void)?
    var startCalls = 0
    var stopCalls = 0
    var resumeCalls = 0
    var refuse = false
    var refuseResume = false
    func start() -> Bool {
        startCalls += 1
        guard !refuse else { return false }
        isPlaying = true
        return true
    }
    var pauseCalls = 0
    func pause() {
        pauseCalls += 1
        isPlaying = false
    }
    func resume() -> Bool {
        resumeCalls += 1
        guard !refuseResume else { return false }
        isPlaying = true
        return true
    }
    func stop() {
        stopCalls += 1
        isPlaying = false
    }
}

@MainActor
private final class FakeConditions: DeviceConditions {
    var current = DeviceSnapshot(lowPowerMode: false, batteryLevel: 0.9, pluggedIn: false)
    var onChange: (@MainActor () -> Void)?
    var monitoring = false
    func setMonitoring(_ on: Bool) { monitoring = on }
    /// Like the system: with monitoring off the battery level is unknown.
    func snapshot() -> DeviceSnapshot {
        var s = current
        if !monitoring { s.batteryLevel = nil }
        return s
    }
    func change(_ edit: (inout DeviceSnapshot) -> Void) {
        edit(&current)
        onChange?()
    }
}

@MainActor
private final class Rig {
    let audio = FakeAudio()
    let arbiter = AudioSessionArbiter()
    let conditions = FakeConditions()
    let ledger = AwakeTimeLedger(directory: nil)
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    var keep: [Bool] = []
    var stops: [StayAwake.StopReason] = []
    var cap = AwakeCapStore(directory: nil)
    var controller: StayAwakeController!

    init(cap: AwakeCapStore? = nil, start: Date? = nil) {
        if let start { now = start }
        if let cap { self.cap = cap }
        controller = StayAwakeController(
            audio: audio, conditions: conditions, ledger: ledger, capStore: self.cap,
            setKeepConnected: { [unowned self] in keep.append($0) },
            onStopped: { [unowned self] in stops.append($0) },
            clock: { [unowned self] in now }, arbiter: arbiter)
        controller.setForeground(true)
    }

    func watch(_ n: Int = 1) {
        controller.setSwitch(true)
        controller.setTasks(watched: n, active: Set((1...n).map { "t\($0)" }))
    }
}

@MainActor
struct StayAwakeControllerTests {
    @Test func doesNothingByDefault() {
        let rig = Rig()
        rig.controller.setTasks(watched: 1, active: ["t1"])
        #expect(!rig.controller.isRunning)
        #expect(rig.audio.startCalls == 0)
    }

    @Test func startsWhenTheSwitchIsOnAndATaskIsWatched() {
        let rig = Rig()
        rig.watch()
        #expect(rig.controller.isRunning)
        #expect(rig.audio.isPlaying)
        #expect(rig.keep == [true])
    }

    @Test func doesNotStartWithoutAWatchedTask() {
        let rig = Rig()
        rig.controller.setSwitch(true)
        #expect(!rig.controller.isRunning)
        #expect(rig.audio.startCalls == 0)
    }

    @Test func stopsAsSoonAsNothingIsRunning() {
        let rig = Rig()
        rig.watch()
        rig.controller.setTasks(watched: 1, active: [])
        #expect(!rig.controller.isRunning)
        #expect(rig.audio.stopCalls == 1)
        #expect(rig.keep == [true, false])
        #expect(rig.stops == [.nothingRunning])
    }

    @Test func stopsWhenTheOwnerStopsWatching() {
        let rig = Rig()
        rig.watch()
        rig.controller.setTasks(watched: 0, active: [])
        #expect(rig.stops == [.notWatching])
    }

    @Test func stopsWhenTheSwitchIsTurnedOff() {
        let rig = Rig()
        rig.watch()
        rig.controller.setSwitch(false)
        #expect(rig.stops == [.switchOff])
        #expect(!rig.audio.isPlaying)
    }

    @Test func stopsOnLowPowerModeAndStartsAgainWhenItEnds() {
        let rig = Rig()
        rig.watch()
        rig.conditions.change { $0.lowPowerMode = true }
        #expect(rig.stops == [.lowPowerMode])
        #expect(!rig.controller.isRunning)
        rig.conditions.change { $0.lowPowerMode = false }
        #expect(rig.controller.isRunning)
    }

    @Test func doesNotStartInLowPowerMode() {
        let rig = Rig()
        rig.conditions.current.lowPowerMode = true
        rig.watch()
        #expect(rig.audio.startCalls == 0)
    }

    @Test func stopsBelowTwentyPercentUnplugged() {
        let rig = Rig()
        rig.watch()
        rig.conditions.change { $0.batteryLevel = 0.19 }
        #expect(rig.stops == [.lowBattery])
        rig.conditions.change { $0.pluggedIn = true }  // plugging in brings it back
        #expect(rig.controller.isRunning)
    }

    @Test func stopsAtTheHardCapAndStaysOffForTheSameTasks() {
        let rig = Rig()
        rig.watch()
        rig.now.addTimeInterval(3 * 3600)
        rig.controller.reevaluate()
        #expect(rig.stops == [.hardCap])
        // A new event for the same running task must not start it again.
        rig.controller.setGateway(live: true)
        rig.conditions.change { $0.batteryLevel = 0.85 }
        #expect(!rig.controller.isRunning)
        // New work after everything finished starts fresh.
        rig.controller.setTasks(watched: 0, active: [])
        rig.controller.setTasks(watched: 1, active: ["t1"])
        #expect(rig.controller.isRunning)
    }

    @Test func stopsWhenTheGatewayIsUnreachableForTenMinutes() {
        let rig = Rig()
        rig.watch()
        rig.controller.setGateway(live: false)
        rig.now.addTimeInterval(9 * 60)
        rig.controller.reevaluate()
        #expect(rig.controller.isRunning)
        rig.now.addTimeInterval(61)
        rig.controller.reevaluate()
        #expect(rig.stops == [.gatewayUnreachable])
    }

    @Test func aGatewayThatComesBackResetsTheTenMinutes() {
        let rig = Rig()
        rig.watch()
        rig.controller.setGateway(live: false)
        rig.now.addTimeInterval(9 * 60)
        rig.controller.setGateway(live: true)
        rig.controller.setGateway(live: false)
        rig.now.addTimeInterval(9 * 60)
        rig.controller.reevaluate()
        #expect(rig.controller.isRunning)
    }

    @Test func resumesAfterACallWhenStillNeeded() {
        let rig = Rig()
        rig.watch()
        rig.audio.isPlaying = false  // iOS paused it for the call
        rig.audio.onEvent?(.interrupted)
        rig.audio.onEvent?(.interruptionEnded)
        #expect(rig.audio.resumeCalls == 1)
        #expect(rig.audio.isPlaying)
        #expect(rig.controller.isRunning)
    }

    @Test func doesNotResumeAfterACallIfTheTaskFinishedMeanwhile() {
        let rig = Rig()
        rig.watch()
        rig.audio.isPlaying = false
        rig.audio.onEvent?(.interrupted)
        rig.controller.setTasks(watched: 1, active: [])  // finished during the call
        #expect(!rig.controller.isRunning)
        rig.audio.onEvent?(.interruptionEnded)
        #expect(rig.audio.resumeCalls == 0)
        #expect(!rig.audio.isPlaying)
    }

    @Test func resumesAfterARouteChangeThatPausedIt() {
        let rig = Rig()
        rig.watch()
        rig.audio.isPlaying = false  // headphones unplugged: iOS paused
        rig.audio.onEvent?(.routeChanged)
        #expect(rig.audio.resumeCalls == 1)
    }

    @Test func aRouteChangeThatChangedNothingLeavesItAlone() {
        let rig = Rig()
        rig.watch()
        rig.audio.onEvent?(.routeChanged)
        #expect(rig.audio.resumeCalls == 0)
    }

    @Test func aRefusedSessionStaysOffWithoutLooping() {
        let rig = Rig()
        rig.audio.refuse = true
        rig.watch()
        #expect(!rig.controller.isRunning)
        #expect(rig.keep.isEmpty)
        #expect(rig.audio.startCalls == 1)
    }

    @Test func recordsAwakeTimeWhenItStops() async {
        let rig = Rig()
        rig.watch()
        rig.now.addTimeInterval(42 * 60)
        #expect(Int(await rig.controller.secondsToday()) == 42 * 60)  // the stretch in progress counts
        rig.controller.setTasks(watched: 1, active: [])
        await rig.controller.settled()
        #expect(Int(await rig.controller.secondsToday()) == 42 * 60)  // and is kept once it ended
    }

    @Test func doesNotStartInTheBackground() {
        let rig = Rig()
        rig.controller.setForeground(false)
        rig.watch()
        #expect(rig.audio.startCalls == 0)  // iOS refuses audio from the background
        rig.controller.setForeground(true)
        #expect(rig.controller.isRunning)
        rig.controller.setForeground(false)  // once running, leaving the screen is the point
        #expect(rig.controller.isRunning)
    }

    @Test func dictationBorrowsTheSessionAndStayAwakeTakesItBack() async {
        let rig = Rig()
        rig.watch()
        let claim = rig.arbiter.begin()
        #expect(rig.audio.pauseCalls == 1)
        #expect(rig.controller.isPaused)
        #expect(rig.audio.stopCalls == 0)  // it does not pull the session out from under dictation
        rig.now.addTimeInterval(600)  // ten minutes of dictation: not awake time
        rig.arbiter.end(claim)
        #expect(rig.audio.resumeCalls == 1)
        #expect(!rig.controller.isPaused)
        rig.now.addTimeInterval(120)
        rig.controller.setTasks(watched: 1, active: [])
        await rig.controller.settled()
        #expect(Int(await rig.controller.secondsToday()) == 120)
    }

    @Test func doesNotStartWhileDictating() {
        let rig = Rig()
        let claim = rig.arbiter.begin()
        rig.watch()
        #expect(rig.audio.startCalls == 0)
        rig.arbiter.end(claim)
        #expect(rig.controller.isRunning)
    }

    @Test func stopsWhenTheSessionCannotBeTakenBackAfterDictation() {
        let rig = Rig()
        rig.watch()
        let claim = rig.arbiter.begin()
        rig.audio.refuseResume = true
        rig.arbiter.end(claim)
        #expect(rig.stops == [.audioUnavailable])
        #expect(!rig.controller.isRunning)
    }

    @Test func theCapSurvivesARelaunch() {
        let rig = Rig()
        rig.watch()
        rig.now.addTimeInterval(3 * 3600)
        rig.controller.reevaluate()
        #expect(rig.stops == [.hardCap])
        // The app restarts: a new controller over the same store, the same task still running.
        let again = Rig(cap: rig.cap)
        again.watch()
        #expect(!again.controller.isRunning)
        #expect(again.audio.startCalls == 0)
        // A different task is new work and gets its own three hours.
        again.controller.setTasks(watched: 1, active: ["other"])
        #expect(again.controller.isRunning)
    }

    @Test func aRelaunchContinuesTheBudgetInsteadOfRestartingIt() {
        let rig = Rig()
        rig.watch()
        rig.now.addTimeInterval(2 * 3600)
        rig.conditions.change { $0.lowPowerMode = true }  // the stretch ends and its time is saved
        let again = Rig(cap: rig.cap, start: rig.now)  // killed after two hours of use, restarted
        again.watch()
        #expect(again.controller.isRunning)
        again.now.addTimeInterval(3600 - 1)
        again.controller.reevaluate()
        #expect(again.controller.isRunning)
        again.now.addTimeInterval(1)
        again.controller.reevaluate()
        #expect(again.stops == [.hardCap])
    }

    @Test func theFirstStartAlreadyChecksTheBattery() {
        let rig = Rig()
        rig.conditions.current.batteryLevel = 0.15  // unplugged at 15%
        rig.watch()
        #expect(rig.audio.startCalls == 0)  // monitoring was on before the snapshot was read
        #expect(!rig.controller.isRunning)
        rig.conditions.change { $0.pluggedIn = true }
        #expect(rig.controller.isRunning)
    }

    @Test func sendingAMessageWithNoDictationLeavesTheLoopAlone() {
        let rig = Rig()
        rig.watch()
        // A send or a thread exit stops a dictation that is not running: that holds no claim and changes nothing.
        rig.arbiter.end(UUID())
        #expect(rig.controller.isRunning)
        #expect(!rig.controller.isPaused)
        #expect(rig.audio.isPlaying)
        #expect(rig.audio.pauseCalls == 0 && rig.audio.stopCalls == 0 && rig.audio.resumeCalls == 0)
    }

    @Test func twoDictationsKeepTheSessionLentUntilBothAreDone() {
        let rig = Rig()
        rig.watch()
        let home = rig.arbiter.begin()
        let chat = rig.arbiter.begin()
        #expect(rig.controller.isPaused)
        rig.arbiter.end(home)
        #expect(rig.controller.isPaused)  // the chat dictation still holds it
        rig.arbiter.end(chat)
        #expect(!rig.controller.isPaused)
        #expect(rig.audio.isPlaying)
    }

    @Test func batteryMonitoringIsOnlyWhileThereIsSomethingToWatch() {
        let rig = Rig()
        #expect(!rig.conditions.monitoring)
        rig.controller.setSwitch(true)
        rig.controller.setTasks(watched: 1, active: ["t1"])
        #expect(rig.conditions.monitoring)
        rig.controller.setTasks(watched: 0, active: [])
        #expect(!rig.conditions.monitoring)
    }
}
