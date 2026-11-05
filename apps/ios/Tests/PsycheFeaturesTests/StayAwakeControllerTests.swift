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
    func start() -> Bool {
        startCalls += 1
        guard !refuse else { return false }
        isPlaying = true
        return true
    }
    func resume() -> Bool {
        resumeCalls += 1
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
    func snapshot() -> DeviceSnapshot { current }
    func change(_ edit: (inout DeviceSnapshot) -> Void) {
        edit(&current)
        onChange?()
    }
}

@MainActor
private final class Rig {
    let audio = FakeAudio()
    let conditions = FakeConditions()
    let ledger = AwakeTimeLedger(directory: nil)
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    var keep: [Bool] = []
    var stops: [StayAwake.StopReason] = []
    var controller: StayAwakeController!

    init() {
        controller = StayAwakeController(
            audio: audio, conditions: conditions, ledger: ledger,
            setKeepConnected: { [unowned self] in keep.append($0) },
            onStopped: { [unowned self] in stops.append($0) },
            clock: { [unowned self] in now })
    }

    func watch(_ n: Int = 1) {
        controller.setSwitch(true)
        controller.setTasks(watched: n, active: n)
    }
}

@MainActor
struct StayAwakeControllerTests {
    @Test func doesNothingByDefault() {
        let rig = Rig()
        rig.controller.setTasks(watched: 1, active: 1)
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
        rig.controller.setTasks(watched: 1, active: 0)
        #expect(!rig.controller.isRunning)
        #expect(rig.audio.stopCalls == 1)
        #expect(rig.keep == [true, false])
        #expect(rig.stops == [.nothingRunning])
    }

    @Test func stopsWhenTheOwnerStopsWatching() {
        let rig = Rig()
        rig.watch()
        rig.controller.setTasks(watched: 0, active: 0)
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
        rig.controller.setTasks(watched: 0, active: 0)
        rig.controller.setTasks(watched: 1, active: 1)
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
        rig.controller.setTasks(watched: 1, active: 0)  // finished during the call
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
        rig.controller.setTasks(watched: 1, active: 0)
        try? await Task.sleep(for: .milliseconds(50))
        #expect(Int(await rig.controller.secondsToday()) == 42 * 60)  // and is kept once it ended
    }
}
